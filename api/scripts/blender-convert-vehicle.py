import os
import sys
import json
import re
import bpy


COLOR_HEX_RE = re.compile(r"0x([0-9a-fA-F]{8})")
HASH_COLOR_RE = re.compile(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})")
TEXTURE_MAX_SIZE = int(os.environ.get("VEHICLE_TEXTURE_MAX", "1024") or "1024")
DECIMATE_RATIO = float(os.environ.get("VEHICLE_DECIMATE_RATIO", "1.0") or "1.0")
DECIMATE_MIN_FACES = int(os.environ.get("VEHICLE_DECIMATE_MIN_FACES", "25000") or "25000")
DRACO_ENABLED = os.environ.get("VEHICLE_DRACO", "1").lower() not in {"0", "false", "no", "off"}
DRACO_LEVEL = int(os.environ.get("VEHICLE_DRACO_LEVEL", "6") or "6")


def find_model_files(root):
    matches = []
    for base, _dirs, files in os.walk(root):
        for name in files:
            ext = os.path.splitext(name.lower())[1]
            if ext in {".dae", ".fbx", ".obj"}:
                matches.append(os.path.join(base, name))
    primary_matches = []
    for model_file in matches:
        name = os.path.basename(model_file).lower()
        if any(token in name for token in ("collider", "collision")):
            continue
        if re.search(r"(^|[_\-.])lod([_\-.]|[a-z0-9])", name):
            continue
        primary_matches.append(model_file)
    if primary_matches:
        matches = primary_matches
    matches.sort(key=lambda p: (0 if "car" in os.path.basename(p).lower() or "body" in os.path.basename(p).lower() else 1, len(p)))
    return matches


def clean_key(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def mesh_key(value):
    name = re.sub(r"\.\d{3}$", "", str(value or ""))
    return clean_key(name)


def clamp01(value):
    try:
        return max(0.0, min(1.0, float(value)))
    except Exception:
        return 0.0


def rgba_from_array(value):
    if not isinstance(value, (list, tuple)) or len(value) < 3:
        return None
    if not all(isinstance(v, (int, float, str)) for v in value[:3]):
        return None
    try:
        vals = [float(v) for v in value[:4] if isinstance(v, (int, float, str))]
    except Exception:
        return None
    if len(vals) < 3:
        return None
    if any(v > 1.0 for v in vals):
        vals = [v / 255.0 for v in vals]
    while len(vals) < 4:
        vals.append(1.0)
    return tuple(clamp01(v) for v in vals[:4])


def rgba_from_hex_text(text):
    text = str(text or "")
    hash_match = HASH_COLOR_RE.search(text)
    if hash_match:
        raw = hash_match.group(1)
        if len(raw) == 8:
            a, r, g, b = raw[0:2], raw[2:4], raw[4:6], raw[6:8]
        else:
            r, g, b, a = raw[0:2], raw[2:4], raw[4:6], "ff"
        return (int(r, 16) / 255.0, int(g, 16) / 255.0, int(b, 16) / 255.0, int(a, 16) / 255.0)
    match = COLOR_HEX_RE.search(text)
    if not match:
        return None
    raw = match.group(1)
    # BeamNG/Automation color texture names usually store alpha first:
    # camso_col_0xff525258.dds -> rgba(0x52, 0x52, 0x58, 0xff)
    if raw[:2].lower() == "ff":
        r, g, b, a = raw[2:4], raw[4:6], raw[6:8], raw[0:2]
    else:
        r, g, b, a = raw[0:2], raw[2:4], raw[4:6], raw[6:8]
    return (int(r, 16) / 255.0, int(g, 16) / 255.0, int(b, 16) / 255.0, int(a, 16) / 255.0)


def color_from_value(value):
    if isinstance(value, str):
        return rgba_from_hex_text(value)
    if isinstance(value, (list, tuple)):
        color = rgba_from_array(value)
        if color:
            return color
        for item in value:
            color = color_from_value(item)
            if color:
                return color
    if isinstance(value, dict):
        for key in ("baseColorFactor", "baseColor", "diffuseColor", "diffuse", "color"):
            color = rgba_from_array(value.get(key))
            if color:
                return color
        for key in ("baseColorMap", "colorMap", "diffuseMap", "overlayMap", "mapTo", "name"):
            color = rgba_from_hex_text(value.get(key))
            if color:
                return color
        for item in value.values():
            color = color_from_value(item)
            if color:
                return color
    return None


def load_material_hints(source_dir):
    hints = {}
    for base, _dirs, files in os.walk(source_dir):
        for name in files:
            if not name.lower().endswith(".materials.json"):
                continue
            full = os.path.join(base, name)
            try:
                with open(full, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
            except Exception:
                continue
            materials = data.get("materials", data) if isinstance(data, dict) else {}
            if isinstance(materials, list):
                materials = {str(i): item for i, item in enumerate(materials)}
            if not isinstance(materials, dict):
                continue
            for key, spec in materials.items():
                names = [key]
                if isinstance(spec, dict):
                    names.extend([spec.get("name"), spec.get("mapTo")])
                color = color_from_value(spec)
                for material_name in names:
                    cleaned = clean_key(material_name)
                    if cleaned:
                        hints[cleaned] = {"color": color, "source": os.path.relpath(full, source_dir)}
    hints.update(load_assetto_skin_hints(source_dir))
    return hints


def skin_sort_key(path):
    lowered = path.lower()
    name = os.path.basename(path).lower()
    if "raven" in name or "black" in name:
        return (0, len(path), path)
    if "wimbledon" in name or "white" in name:
        return (2, len(path), path)
    return (1, len(path), path)


def load_assetto_skin_hints(source_dir):
    hints = {}
    skin_files = []
    for base, _dirs, files in os.walk(source_dir):
        if os.path.basename(os.path.dirname(base)).lower() != "skins":
            continue
        for name in files:
            if name.lower() in {"cm_skin.json", "ui_skin.json"}:
                skin_files.append(os.path.join(base, name))
    skin_files.sort(key=skin_sort_key)
    for full in skin_files:
        try:
            with open(full, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            continue
        paint = data.get("carPaint") if isinstance(data, dict) else None
        color = color_from_value(paint) if paint else None
        if not color:
            color = color_from_value(data)
        if color:
            rel = os.path.relpath(full, source_dir)
            for key in ("extcarpaint", "ext_car_paint", "carpaint", "paint", "body"):
                hints[clean_key(key)] = {"color": color, "source": rel}
            break
    return hints


def load_beam_flexbody_names(source_dir):
    names = set()
    for base, _dirs, files in os.walk(source_dir):
        for name in files:
            if not name.lower().endswith(".jbeam"):
                continue
            full = os.path.join(base, name)
            try:
                with open(full, "r", encoding="utf-8", errors="ignore") as handle:
                    lines = handle.readlines()
            except Exception:
                continue
            inside = False
            depth = 0
            for line in lines:
                stripped = re.sub(r"//.*$", "", line).strip()
                if not inside and re.search(r"['\"]flexbodies['\"]\s*:", stripped):
                    inside = True
                    depth = stripped.count("[") - stripped.count("]")
                    continue
                if not inside:
                    continue
                depth += stripped.count("[") - stripped.count("]")
                match = re.match(r"\[\s*['\"]([^'\"]+)['\"]", stripped)
                if match:
                    candidate = match.group(1).strip()
                    if candidate and clean_key(candidate) != "mesh":
                        names.add(mesh_key(candidate))
                if depth <= 0 and "]" in stripped:
                    inside = False
    return names


def filter_beam_visual_meshes(source_dir):
    flexbodies = load_beam_flexbody_names(source_dir)
    report = {
        "flexbodyCount": len(flexbodies),
        "removed": [],
        "kept": []
    }
    if not flexbodies:
        return report

    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    matched = []
    for obj in mesh_objects:
        keys = {mesh_key(obj.name)}
        if getattr(obj, "data", None):
            keys.add(mesh_key(obj.data.name))
        if any(key in flexbodies or any(flex in key or key in flex for flex in flexbodies) for key in keys if key):
            matched.append(obj)

    # If none of the imported object names line up with JBeam flexbodies, keep
    # the import intact and report the missed hint rather than deleting the car.
    if not matched:
        report["missed"] = True
        return report

    for obj in mesh_objects:
        if obj in matched:
            report["kept"].append(obj.name)
            continue
        report["removed"].append(obj.name)
        bpy.data.objects.remove(obj, do_unlink=True)
    return report


def is_too_dark(color):
    return color[0] < 0.035 and color[1] < 0.035 and color[2] < 0.035


def fallback_material(name):
    lowered = str(name or "").lower()
    metallic = 0.0
    roughness = 0.58
    alpha = 1.0
    color = (0.55, 0.57, 0.60, 1.0)
    if any(token in lowered for token in ("glass", "window", "windshield", "windscreen")):
        color = (0.035, 0.075, 0.095, 0.42)
        roughness = 0.06
        alpha = 0.42
    elif any(token in lowered for token in ("tire", "tyre", "rubber")):
        color = (0.028, 0.026, 0.024, 1.0)
        roughness = 0.82
    elif any(token in lowered for token in ("chrome", "metal", "exhaust", "pipe", "axle", "shaft", "hub")):
        color = (0.62, 0.61, 0.57, 1.0)
        metallic = 0.75
        roughness = 0.31
    elif any(token in lowered for token in ("seat", "leather", "fabric", "carpet", "cloth", "alcantara", "interior", "int_")):
        color = (0.045, 0.043, 0.040, 1.0)
        roughness = 0.74
    elif any(token in lowered for token in ("light", "lamp", "reflector")):
        color = (1.0, 0.90, 0.64, 1.0)
        roughness = 0.18
    elif any(token in lowered for token in ("body", "paint", "car", "efce0", "default")):
        color = (0.72, 0.73, 0.74, 1.0)
        roughness = 0.42
    return color, metallic, roughness, alpha


def set_input(node, name, value):
    if name in node.inputs:
        node.inputs[name].default_value = value


def find_principled(mat):
    if not mat.use_nodes or not mat.node_tree:
        return None
    for node in mat.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return node
    return None


def has_base_color_texture(bsdf):
    if not bsdf or "Base Color" not in bsdf.inputs:
        return False
    return bool(bsdf.inputs["Base Color"].links)


def base_color_texture_paths(bsdf):
    if not bsdf or "Base Color" not in bsdf.inputs:
        return []
    paths = []
    for link in bsdf.inputs["Base Color"].links:
        node = link.from_node
        if node and node.type == "TEX_IMAGE" and getattr(node, "image", None):
            image = node.image
            paths.append(image.filepath or image.name or "")
    return paths


def remove_base_color_texture_links(mat, bsdf):
    if not bsdf or "Base Color" not in bsdf.inputs or not mat.node_tree:
        return 0
    links = list(bsdf.inputs["Base Color"].links)
    for link in links:
        mat.node_tree.links.remove(link)
    return len(links)


def ensure_principled(mat):
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = find_principled(mat)
    if bsdf:
        return bsdf
    out = None
    for node in nodes:
        if node.type == "OUTPUT_MATERIAL":
            out = node
            break
    if not out:
        out = nodes.new(type="ShaderNodeOutputMaterial")
    bsdf = nodes.new(type="ShaderNodeBsdfPrincipled")
    mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return bsdf


def material_kind(name):
    lowered = str(name or "").lower()
    if any(token in lowered for token in ("glass", "window", "windshield", "windscreen")):
        return "glass"
    if any(token in lowered for token in ("tire", "tyre", "rubber")):
        return "rubber"
    if any(token in lowered for token in ("chrome", "polished", "metal", "exhaust", "pipe", "axle", "shaft", "hub", "rim")):
        return "metal"
    if any(token in lowered for token in ("light", "lamp", "reflector")):
        return "lamp"
    if any(token in lowered for token in ("paint", "body", "car_paint", "ext_car")):
        return "paint"
    if any(token in lowered for token in ("seat", "leather", "fabric", "carpet", "cloth", "alcantara", "interior", "int_")):
        return "interior"
    return "general"


def should_keep_base_texture(name):
    lowered = str(name or "").lower()
    return any(token in lowered for token in (
        "badge", "logo", "emblem", "plate", "gauge", "dash", "sticker",
        "number", "dial", "screen", "light", "lamp", "reflector", "decal",
        "trim", "grille", "louver", "spoiler", "splitter", "chrome"
    ))


def should_keep_interior_texture(name):
    lowered = str(name or "").lower()
    return any(token in lowered for token in (
        "badge", "logo", "emblem", "plate", "gauge", "dash", "sticker",
        "number", "dial", "screen", "label", "button", "switch", "decal",
        "radio", "cassette", "odometer", "pedal", "key", "knob",
        "reflector"
    ))


def should_keep_livery_texture(name):
    lowered = str(name or "").lower()
    return any(token in lowered for token in (
        "badge", "logo", "emblem", "plate", "sticker", "number", "decal"
    ))


def should_strip_base_texture(name, texture_paths, kind):
    lowered = str(name or "").lower()
    joined = " ".join(str(path or "").lower() for path in texture_paths)
    if kind == "paint":
        return True
    if any(token in joined for token in ("normal", "_nm", "roughness", "rbgmask", "shadow", "null.dds")):
        return True
    if ("/skins/" in joined or "\\skins\\" in joined) and not should_keep_livery_texture(lowered):
        return True
    if "livery" in joined and not should_keep_livery_texture(lowered):
        return True
    if should_keep_base_texture(lowered):
        return False
    if kind == "interior" and should_keep_interior_texture(lowered):
        return False
    if kind == "interior":
        return True
    if any(token in joined for token in (
        "livery", "ao_body", "body_map", "macrovariation"
    )):
        return any(token in lowered for token in ("body", "paint", "skin", "wrap", "decal"))
    return False


def rebuild_material(mat, hints):
    material_key = clean_key(mat.name)
    hint = hints.get(material_key)
    base = hint.get("color") if hint else None
    if not base:
        for key, candidate in hints.items():
            if key and (key in material_key or material_key in key):
                base = candidate.get("color")
                hint = candidate
                break
    if not base:
        base = tuple(mat.diffuse_color[:4]) if mat.diffuse_color and len(mat.diffuse_color) >= 4 else None
    fallback_color, metallic, roughness, alpha = fallback_material(mat.name)
    if not base or is_too_dark(base):
        base = fallback_color
    base = (clamp01(base[0]), clamp01(base[1]), clamp01(base[2]), clamp01(base[3] if len(base) > 3 else alpha))
    if "glass" in mat.name.lower() or "window" in mat.name.lower():
        base = (base[0], base[1], base[2], min(base[3], 0.45))
    mat.diffuse_color = base
    bsdf = ensure_principled(mat)
    kind = material_kind(mat.name)
    texture_paths_before = base_color_texture_paths(bsdf)
    stripped_texture_links = 0
    if should_strip_base_texture(mat.name, texture_paths_before, kind):
        stripped_texture_links = remove_base_color_texture_links(mat, bsdf)
    # Preserve imported texture wiring from OBJ/MTL/DAE for real detail
    # materials. Paint/body materials are intentionally flattened so random
    # skin overlays do not become the base paint.
    if not has_base_color_texture(bsdf):
        set_input(bsdf, "Base Color", base)
    if kind == "glass":
        metallic = 0.0
        roughness = 0.02
        base = (max(base[0], 0.10), max(base[1], 0.15), max(base[2], 0.18), min(base[3], 0.34))
        if not has_base_color_texture(bsdf):
            set_input(bsdf, "Base Color", base)
    elif kind == "paint":
        metallic = max(metallic, 0.28)
        roughness = min(roughness, 0.36)
    elif kind == "interior":
        metallic = 0.0
        roughness = max(roughness, 0.72)
    elif kind == "metal":
        metallic = max(metallic, 0.78)
        roughness = min(roughness, 0.26)
    elif kind == "rubber":
        metallic = 0.0
        roughness = max(roughness, 0.78)
    set_input(bsdf, "Metallic", metallic)
    set_input(bsdf, "Roughness", roughness)
    set_input(bsdf, "Alpha", base[3])
    set_input(bsdf, "IOR", 1.45)
    mat.blend_method = "BLEND" if base[3] < 0.98 else "OPAQUE"
    mat.use_screen_refraction = base[3] < 0.98
    try:
        mat.show_transparent_back = base[3] >= 0.98
    except Exception:
        pass
    return {
        "name": mat.name,
        "color": [round(v, 4) for v in base],
        "hint": hint.get("source") if hint else "",
        "kind": kind,
        "textured": has_base_color_texture(bsdf),
        "baseTextures": [os.path.basename(path) for path in texture_paths_before[:4]],
        "strippedBaseTextures": stripped_texture_links
    }


def sanitize_materials(source_dir):
    hints = load_material_hints(source_dir)
    report = []
    for mat in bpy.data.materials:
        report.append(rebuild_material(mat, hints))
    return report


def linked_material_images():
    images = set()
    for mat in bpy.data.materials:
        if not mat.use_nodes or not mat.node_tree:
            continue
        for node in mat.node_tree.nodes:
            if node.type != "TEX_IMAGE" or not getattr(node, "image", None):
                continue
            if any(output.links for output in node.outputs):
                images.add(node.image)
    return images


def purge_unlinked_images(used_images):
    report = []
    for image in list(bpy.data.images):
        if image in used_images:
            continue
        report.append(image.name)
        try:
            bpy.data.images.remove(image)
        except Exception:
            pass
    return report


def find_texture_by_basename(source_dir, basename):
    if not basename:
        return ""
    wanted = basename.lower()
    for base, _dirs, files in os.walk(source_dir):
        for name in files:
            if name.lower() == wanted:
                return os.path.join(base, name)
    return ""


def relink_missing_images(source_dir):
    report = []
    for image in bpy.data.images:
        path = bpy.path.abspath(image.filepath or "")
        if path and os.path.exists(path):
            continue
        basename = os.path.basename(image.filepath or image.name or "")
        found = find_texture_by_basename(source_dir, basename)
        if not found:
            continue
        image.filepath = found
        image.filepath_raw = found
        try:
            image.reload()
        except Exception:
            pass
        report.append({"name": image.name, "path": os.path.relpath(found, source_dir)})
    return report


def prepare_export_images(source_dir, used_images):
    report = []
    export_dir = os.path.join(source_dir, "__lmi_export_textures")
    supported = {".png", ".jpg", ".jpeg"}
    for image in list(used_images):
        if image.type != "IMAGE":
            continue
        src = bpy.path.abspath(image.filepath or "")
        ext = os.path.splitext(src or image.name or "")[1].lower()
        if ext in supported:
            try:
                if not image.packed_file:
                    image.pack()
            except Exception:
                pass
            continue
        safe = re.sub(r"[^a-zA-Z0-9._-]+", "_", os.path.splitext(image.name or "texture")[0]).strip("_") or "texture"
        out = os.path.join(export_dir, safe + ".png")
        try:
            os.makedirs(export_dir, exist_ok=True)
            image.save_render(out)
            image.filepath = out
            image.filepath_raw = out
            image.file_format = "PNG"
            try:
                image.pack()
            except Exception:
                pass
            report.append({
                "name": image.name,
                "from": os.path.basename(src or image.name),
                "to": os.path.relpath(out, source_dir)
            })
        except Exception as exc:
            report.append({
                "name": image.name,
                "from": os.path.basename(src or image.name),
                "error": str(exc)
            })
    return report


def optimize_images(max_size, used_images):
    report = []
    if not max_size or max_size <= 0:
        return report
    for image in list(used_images):
        try:
            width, height = int(image.size[0]), int(image.size[1])
        except Exception:
            continue
        if width <= 0 or height <= 0 or max(width, height) <= max_size:
            continue
        scale = max_size / float(max(width, height))
        new_width = max(1, int(width * scale))
        new_height = max(1, int(height * scale))
        try:
            image.scale(new_width, new_height)
            if not image.packed_file:
                image.pack()
            report.append({
                "name": image.name,
                "from": [width, height],
                "to": [new_width, new_height]
            })
        except Exception as exc:
            report.append({
                "name": image.name,
                "from": [width, height],
                "error": str(exc)
            })
    return report


def mesh_face_count(obj):
    if not obj or obj.type != "MESH" or not obj.data:
        return 0
    try:
        return len(obj.data.polygons)
    except Exception:
        return 0


def decimate_meshes(ratio, min_faces):
    report = []
    if not ratio or ratio >= 0.999 or ratio <= 0:
        return report
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [item for item in bpy.context.scene.objects if item.type == "MESH"]:
        before_faces = mesh_face_count(obj)
        if before_faces < min_faces:
            continue
        try:
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            modifier = obj.modifiers.new(name="LMI_showroom_decimate", type="DECIMATE")
            modifier.ratio = ratio
            modifier.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            after_faces = mesh_face_count(obj)
            report.append({
                "name": obj.name,
                "fromFaces": before_faces,
                "toFaces": after_faces,
                "ratio": ratio
            })
            obj.select_set(False)
        except Exception as exc:
            report.append({
                "name": obj.name,
                "fromFaces": before_faces,
                "error": str(exc)
            })
            try:
                obj.select_set(False)
            except Exception:
                pass
    return report


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) < 2:
        raise SystemExit("Usage: blender --background --python blender-convert-vehicle.py -- <source-dir> <model.glb>")

    source_dir = os.path.abspath(args[0])
    output = os.path.abspath(args[1])
    os.makedirs(os.path.dirname(output), exist_ok=True)

    try:
        bpy.ops.preferences.addon_enable(module="io_scene_gltf2")
    except Exception as exc:
        print("Could not explicitly enable io_scene_gltf2: %s" % exc)

    model_files = find_model_files(source_dir)
    if not model_files:
        raise SystemExit("No .dae, .fbx, or .obj files found in vehicle model source. If this pack only has .kn5 files, install the KN5 converter first.")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()

    imported_reports = []
    before_count = len(bpy.context.scene.objects)
    for model_file in model_files:
        before = len(bpy.context.scene.objects)
        try:
            ext = os.path.splitext(model_file.lower())[1]
            if ext == ".dae":
                result = bpy.ops.wm.collada_import(filepath=model_file)
            elif ext == ".fbx":
                result = bpy.ops.import_scene.fbx(filepath=model_file)
            elif ext == ".obj":
                if hasattr(bpy.ops.wm, "obj_import"):
                    result = bpy.ops.wm.obj_import(filepath=model_file)
                else:
                    result = bpy.ops.import_scene.obj(filepath=model_file)
            else:
                result = None
            after = len(bpy.context.scene.objects)
            imported_reports.append({
                "path": os.path.relpath(model_file, source_dir),
                "result": list(result) if result else [],
                "objectsAdded": after - before
            })
        except Exception as exc:
            imported_reports.append({
                "path": os.path.relpath(model_file, source_dir),
                "error": str(exc)
            })

    imported = [obj for obj in bpy.context.scene.objects if obj.type in {"MESH", "EMPTY"}]
    if not imported:
        raise SystemExit("No mesh objects imported from model files. Import report: %s" % json.dumps(imported_reports))

    beam_filter_report = filter_beam_visual_meshes(source_dir)
    relink_report = relink_missing_images(source_dir)
    material_report = sanitize_materials(source_dir)
    used_images = linked_material_images()
    purged_image_report = purge_unlinked_images(used_images)
    export_image_report = prepare_export_images(source_dir, used_images)
    image_report = optimize_images(TEXTURE_MAX_SIZE, used_images)
    decimate_report = decimate_meshes(DECIMATE_RATIO, DECIMATE_MIN_FACES)

    for obj in bpy.context.scene.objects:
        obj.select_set(obj.type == "MESH")

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    total_faces = sum(mesh_face_count(obj) for obj in meshes)
    if meshes:
        bpy.context.view_layer.objects.active = meshes[0]
    mesh_names = [obj.name for obj in meshes]
    wheel_like = [
        name for name in mesh_names
        if any(token in name.lower() for token in ("wheel", "tire", "tyre", "rim"))
    ]
    warnings = []
    if not wheel_like:
        warnings.append("No wheel/tire/rim mesh names were present after Collada import. The source export may omit wheels or name them indirectly.")

    export_kwargs = {
        "filepath": output,
        "export_format": "GLB",
        "export_texcoords": True,
        "export_normals": True,
        "export_materials": "EXPORT",
        "export_apply": False,
    }
    draco_used = False
    if DRACO_ENABLED:
        export_kwargs.update({
            "export_draco_mesh_compression_enable": True,
            "export_draco_mesh_compression_level": max(0, min(10, DRACO_LEVEL)),
            "export_draco_position_quantization": 14,
            "export_draco_normal_quantization": 10,
            "export_draco_texcoord_quantization": 12,
            "export_draco_color_quantization": 10,
            "export_draco_generic_quantization": 12,
        })
        draco_used = True
    try:
        export_result = bpy.ops.export_scene.gltf(**export_kwargs)
    except TypeError:
        for key in list(export_kwargs.keys()):
            if key.startswith("export_draco_"):
                export_kwargs.pop(key, None)
        draco_used = False
        warnings.append("Blender glTF exporter does not support Draco compression in this build; exported plain GLB.")
        export_result = bpy.ops.export_scene.gltf(**export_kwargs)

    if not os.path.exists(output) or os.path.getsize(output) <= 0:
        raise SystemExit("GLB export finished without writing output. Result: %s Import report: %s" % (list(export_result), json.dumps(imported_reports)))

    print("VEHICLE_CONVERT_REPORT " + json.dumps({
        "source": source_dir,
        "output": output,
        "outputBytes": os.path.getsize(output),
        "modelFiles": len(model_files),
        "objectsBeforeImport": before_count,
        "objectsAfterImport": len(bpy.context.scene.objects),
        "meshObjects": len(meshes),
        "totalFaces": total_faces,
        "meshSample": mesh_names[:80],
        "wheelLikeMeshes": wheel_like[:80],
        "decimateRatio": DECIMATE_RATIO,
        "meshesDecimated": len([item for item in decimate_report if "toFaces" in item]),
        "decimateSample": decimate_report[:80],
        "materialsSanitized": len(material_report),
        "materialSample": material_report[:80],
        "beamFilter": beam_filter_report,
        "imagesRelinked": len(relink_report),
        "relinkSample": relink_report[:80],
        "imagesUsedByMaterials": len(used_images),
        "imagesPurged": len(purged_image_report),
        "purgedImageSample": purged_image_report[:80],
        "imagesPreparedForExport": len([item for item in export_image_report if "to" in item]),
        "exportImageSample": export_image_report[:80],
        "textureMaxSize": TEXTURE_MAX_SIZE,
        "dracoEnabled": DRACO_ENABLED,
        "dracoUsed": draco_used,
        "dracoLevel": DRACO_LEVEL,
        "imagesOptimized": len([item for item in image_report if "to" in item]),
        "imageSample": image_report[:80],
        "warnings": warnings,
        "imports": imported_reports,
        "exportResult": list(export_result)
    }))


if __name__ == "__main__":
    main()
