import os
import sys
import json
import re
import bpy


COLOR_HEX_RE = re.compile(r"0x([0-9a-fA-F]{8})")


def find_dae(root):
    matches = []
    for base, _dirs, files in os.walk(root):
        for name in files:
            if name.lower().endswith(".dae"):
                matches.append(os.path.join(base, name))
    matches.sort(key=lambda p: (0 if "car" in os.path.basename(p).lower() or "body" in os.path.basename(p).lower() else 1, len(p)))
    return matches


def clean_key(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def clamp01(value):
    try:
        return max(0.0, min(1.0, float(value)))
    except Exception:
        return 0.0


def rgba_from_array(value):
    if not isinstance(value, (list, tuple)) or len(value) < 3:
        return None
    vals = [float(v) for v in value[:4]]
    if any(v > 1.0 for v in vals):
        vals = [v / 255.0 for v in vals]
    while len(vals) < 4:
        vals.append(1.0)
    return tuple(clamp01(v) for v in vals[:4])


def rgba_from_hex_text(text):
    match = COLOR_HEX_RE.search(str(text or ""))
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
    return hints


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
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    bsdf = nodes.new(type="ShaderNodeBsdfPrincipled")
    out = nodes.new(type="ShaderNodeOutputMaterial")
    set_input(bsdf, "Base Color", base)
    set_input(bsdf, "Metallic", metallic)
    set_input(bsdf, "Roughness", roughness)
    set_input(bsdf, "Alpha", base[3])
    set_input(bsdf, "IOR", 1.45)
    mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    mat.blend_method = "BLEND" if base[3] < 0.98 else "OPAQUE"
    mat.use_screen_refraction = base[3] < 0.98
    return {
        "name": mat.name,
        "color": [round(v, 4) for v in base],
        "hint": hint.get("source") if hint else ""
    }


def sanitize_materials(source_dir):
    hints = load_material_hints(source_dir)
    report = []
    for mat in bpy.data.materials:
        report.append(rebuild_material(mat, hints))
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

    dae_files = find_dae(source_dir)
    if not dae_files:
        raise SystemExit("No .dae files found in vehicle model source.")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()

    imported_reports = []
    before_count = len(bpy.context.scene.objects)
    for dae in dae_files:
        before = len(bpy.context.scene.objects)
        try:
            result = bpy.ops.wm.collada_import(filepath=dae)
            after = len(bpy.context.scene.objects)
            imported_reports.append({
                "path": os.path.relpath(dae, source_dir),
                "result": list(result) if result else [],
                "objectsAdded": after - before
            })
        except Exception as exc:
            imported_reports.append({
                "path": os.path.relpath(dae, source_dir),
                "error": str(exc)
            })

    imported = [obj for obj in bpy.context.scene.objects if obj.type in {"MESH", "EMPTY"}]
    if not imported:
        raise SystemExit("No mesh objects imported from .dae files. Import report: %s" % json.dumps(imported_reports))

    material_report = sanitize_materials(source_dir)

    for obj in bpy.context.scene.objects:
        obj.select_set(obj.type == "MESH")

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
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

    export_result = bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_apply=False
    )

    if not os.path.exists(output) or os.path.getsize(output) <= 0:
        raise SystemExit("GLB export finished without writing output. Result: %s Import report: %s" % (list(export_result), json.dumps(imported_reports)))

    print("VEHICLE_CONVERT_REPORT " + json.dumps({
        "source": source_dir,
        "output": output,
        "outputBytes": os.path.getsize(output),
        "daeFiles": len(dae_files),
        "objectsBeforeImport": before_count,
        "objectsAfterImport": len(bpy.context.scene.objects),
        "meshObjects": len(meshes),
        "meshSample": mesh_names[:80],
        "wheelLikeMeshes": wheel_like[:80],
        "materialsSanitized": len(material_report),
        "materialSample": material_report[:80],
        "warnings": warnings,
        "imports": imported_reports,
        "exportResult": list(export_result)
    }))


if __name__ == "__main__":
    main()
