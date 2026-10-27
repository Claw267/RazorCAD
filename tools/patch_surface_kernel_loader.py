"""Keep RazorCAD's lifetime and thread hooks in newly linked OCCT loaders.
Usage: python tools/patch_surface_kernel_loader.py INPUT OUTPUT [--multi]
Fails closed if the generated Embind layout changes.
"""
from pathlib import Path
import re
import sys

source, destination = map(Path, sys.argv[1:3])
s = source.read_text()
assert 'razorcadDtors' not in s, 'Input is already patched'
identifier = r'[A-Za-z_$][\w$]*'
module = re.search(r'var\s+('+identifier+r')=moduleArg[,;]', s)
assert module, 'Module object was not recognized'
module = module.group(1)
handle = re.compile(r'('+identifier+r')\.count=\{value:1\};return ('+identifier+r')\(Object\.create\(('+identifier+r'),\{('+identifier+r'):\{value:\1,writable:!0\}\}\)\)\}')
assert len(list(handle.finditer(s))) == 1, 'Class-handle constructor changed'
s = handle.sub(lambda m: f'{m[1]}.count={{value:1}};var razorcadH={m[2]}(Object.create({m[3]},{{{m[4]}:{{value:{m[1]},writable:!0}}}}));{module}.razorcadOnHandle?.(razorcadH);return razorcadH}}', s)
constructor = re.compile(r'var ('+identifier+r')=new ('+identifier+r')\(('+identifier+r'(?:,'+identifier+r'){7})\);if\(\1\.')
classes = list(constructor.finditer(s))
assert len(classes) == 1, f'Class registration changed: {len(classes)} matches'
m = classes[0]
args = m[3].split(',')
name, destructor = args[0], args[3]
prefix = s[:m.start()]
conversion = list(re.finditer(re.escape(destructor)+r'='+identifier+r'\('+identifier+','+re.escape(destructor)+r'\);', prefix))
assert conversion and m.start()-conversion[-1].start() < 4000, 'Raw destructor conversion changed'
c = conversion[-1]
s = s[:m.end()-len('if('+m[1]+'.')]+f'({module}.razorcadDtors??={{}})[{name}]=razorcadDtor;'+s[m.end()-len('if('+m[1]+'.'):]
s = s[:c.start()]+f'var razorcadDtor={destructor};'+s[c.start():]
if '--multi' in sys.argv[3:]:
    assert s.count('navigator.hardwareConcurrency') == 2, 'Thread-count setup changed'
    s = s.replace('navigator.hardwareConcurrency',f'({module}.razorcadThreads??navigator.hardwareConcurrency)')
destination.write_text(s)
print(f'Patched lifetime hooks'+(' and thread count' if '--multi' in sys.argv[3:] else ''))
