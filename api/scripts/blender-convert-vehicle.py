import os
import sys
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
    dae_files = find_dae(source_dir)
    if not dae_files:
        raise SystemExit("No .dae files found in vehicle model source.")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()

    for dae in dae_files:
        bpy.ops.wm.collada_import(filepath=dae)

    imported = [obj for obj in bpy.context.scene.objects if obj.type in {"MESH", "EMPTY"}]
    if not imported:
        raise SystemExit("No mesh objects imported from .dae files.")

    for obj in bpy.context.scene.objects:
        obj.select_set(obj.type == "MESH")

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if meshes:
        bpy.context.view_layer.objects.active = meshes[0]

    bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_apply=True
    )


if __name__ == "__main__":
    main()
