"""Builds the RazorCAD Part Builder page (claude.ai artifact) from template.html, with the same
modelling guide that RazorCAD's Ask Claude panel uses (app/js/claudespec.js, RAZORCAD_GUIDE)."""
import json
import os
import re

here = os.path.dirname(os.path.abspath(__file__))
spec = open(os.path.join(here, '..', 'app', 'js', 'claudespec.js'), encoding='utf-8').read()
m = re.search(r'export const RAZORCAD_GUIDE = `(.*?)`;\s*\n', spec, re.S)
guide = m.group(1).replace('\\`', '`').replace('\\\\', '\\')
page = open(os.path.join(here, 'template.html'), encoding='utf-8').read()
page = page.replace('__GUIDE__', json.dumps(guide, ensure_ascii=False).replace('</', '<\\/'))
open(os.path.join(here, 'razorcad-part-builder.html'), 'w', encoding='utf-8', newline='\n').write(page)
print('written', len(page), 'chars')
