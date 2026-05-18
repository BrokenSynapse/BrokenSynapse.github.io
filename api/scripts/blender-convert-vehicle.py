import os
import sys
import json
import bpy


def find_dae(root):
    matches = []
    for base, _dirs, files in os.walk(root):
        for name in files:
            if name.lower().endswith(".dae"):
                matches.append(os.path.join(base, name))
    matches.sort(key=lambda p: (0 if "car" in os.path.basename(p).lower() or "body" in os.path.basename(p).lower() else 1, len(p)))
    return matches


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

    for obj in bpy.context.scene.objects:
        obj.select_set(obj.type == "MESH")

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if meshes:
        bpy.context.view_layer.objects.active = meshes[0]

    export_result = bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_apply=True
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
        "imports": imported_reports,
        "exportResult": list(export_result)
    }))


if __name__ == "__main__":
    main()
