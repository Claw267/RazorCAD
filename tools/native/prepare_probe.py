"""Stage an isolated surface-kernel probe from RazorCAD's pinned replicad sources.
Usage: python tools/native/prepare_probe.py /path/to/replicad /path/to/new-build-dir
"""
from pathlib import Path
import shutil
import subprocess
import argparse

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('source',type=Path)
parser.add_argument('destination',type=Path)
parser.add_argument('--release',action='store_true',help='Optimized single and multi configurations with stable stack/free exports')
args=parser.parse_args();source,destination=args.source,args.destination
revision = 'a0bc495676b65ef79ad8ab496238fa145fd0ff67'
prefix = 'packages/replicad-opencascadejs/build-config/'
files = subprocess.check_output(['git', '-C', str(source), 'ls-tree', '-r', '--name-only', revision, '--', prefix], text=True).splitlines()
if not files:
    raise SystemExit('Pinned replicad build configuration not found')
destination.mkdir(parents=True, exist_ok=False)
for name in files:
    target = destination / name.removeprefix(prefix)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(subprocess.check_output(['git', '-C', str(source), 'show', f'{revision}:{name}']))
here = Path(__file__).resolve().parent
shutil.copyfile(here / 'surface-patch.cpp', destination / 'wrappers/surface-patch.cpp')
for name in ['custom_build_single.yml','custom_build_multi.yml']:
    config=destination/name
    s=config.read_text(encoding='utf-8')
    assert s.count('  emccFlags:')==1 and s.count('additionalCppFiles:')==1
    s=s.replace('  emccFlags:','  - symbol: RazorCADSurfacePatch\n  emccFlags:')
    assert 'EXPORTED_FUNCTIONS' not in s
    s=s.replace('  - --no-entry','  - -sEXPORTED_FUNCTIONS=["_malloc","_free","___libc_free","_emscripten_stack_get_current","__emscripten_stack_restore"]\n  - --no-entry')
    if not args.release:
        s=s.replace('  - -O3\n','  - -O0\n').replace('  - -sEVAL_CTORS=2\n','')
    s+='\n- wrappers/surface-patch.cpp\n';config.write_text(s,encoding='utf-8')
print(destination)
