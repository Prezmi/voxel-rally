# Blender asset scripts

Assets are built by headless Blender scripts, not by hand: run
`blender --background --python tools/blender/<name>.py` from the project root and the script
writes `assets/models/<name>.glb` plus its baked texture maps into `assets/textures/`.
Keep every model under the budget in `PLAN.md` §7 (car ≤ 60 k triangles and ≤ 6 MB, prop ≤ 4 k triangles),
name the file exactly as the game asks for it, and let `src/render/assets.js` fall back to procedural
geometry when the file is absent — a missing asset must never break a drive.
