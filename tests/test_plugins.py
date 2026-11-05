"""Plug-in folder tests (razorcad.py: Documents\\RazorCAD\\Plugins), runnable without a desktop GUI:
python -m unittest discover -s tests -p test_plugins.py.

Only the plug-in definitions are loaded from the desktop entry point (as test_updater.py does), so pywebview isn't.
"""
import ast
import base64
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import unittest
import zipfile

NAMES = {'plugin_path', 'list_plugins', 'read_plugin', 'read_plugin_file', 'plugin_free_id', 'write_new_plugin', 'install_plugin_zip'}
CONSTS = {'PLUGIN_ID', 'PLUGIN_CODE_EXTS', 'PLUGIN_MAX_BYTES'}


def plugin_namespace():
    source = ast.parse((Path(__file__).resolve().parents[1] / 'razorcad.py').read_text(encoding='utf-8'))
    body = [n for n in source.body if (isinstance(n, ast.FunctionDef) and n.name in NAMES)
            or (isinstance(n, ast.Assign) and any(getattr(t, 'id', None) in CONSTS for t in n.targets))]
    ns = dict(os=os, re=re, json=json, shutil=shutil, base64=base64)
    exec(compile(ast.Module(body=body, type_ignores=[]), 'razorcad.py', 'exec'), ns)
    return ns


class PluginFolderTests(unittest.TestCase):
    def setUp(self):
        self.ns = plugin_namespace()
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, rel, text):
        p = os.path.join(self.dir, *rel.split('/'))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        Path(p).write_text(text, encoding='utf-8')

    def test_paths_stay_inside_the_plugin(self):
        path = self.ns['plugin_path']
        self.assertTrue(path(self.dir, 'Fans', 'lib/a.js').endswith(os.path.join('Fans', 'lib', 'a.js')))
        for pid, rel in [('Fans', '../Other/main.js'), ('Fans', '../../x'), ('..', ''), ('a/b', ''), ('', ''), ('Fans', 'C:/Windows/win.ini')]:
            with self.assertRaises(ValueError, msg=(pid, rel)):
                path(self.dir, pid, rel)

    def test_list_reads_manifests_and_reports_broken_ones(self):
        self.write('Good/plugin.json', '{"name": "Good", "version": "1.0"}')
        self.write('Good/main.js', 'export function activate() {}')
        self.write('Bad/plugin.json', '{not json')
        os.makedirs(os.path.join(self.dir, 'Empty'))
        self.write('loose.js', '')  # (a file, not a folder: not a plug-in)
        found = {p['id']: p for p in self.ns['list_plugins'](self.dir)}
        self.assertEqual(sorted(found), ['Bad', 'Empty', 'Good'])
        self.assertEqual(found['Good']['manifest']['name'], 'Good')
        self.assertGreater(found['Good']['modified'], 0)
        self.assertIn('plugin.json', found['Bad']['error'])
        self.assertIn('no plugin.json', found['Empty']['error'])

    def test_read_gives_the_code_only(self):
        self.write('P/plugin.json', '{}')
        self.write('P/main.js', 'import "./lib/u.mjs";')
        self.write('P/lib/u.mjs', 'export {}')
        self.write('P/node_modules/big.js', 'x')
        self.write('P/data.json', '{"a": 1}')
        files = self.ns['read_plugin'](self.dir, 'P')['files']
        self.assertEqual(sorted(files), ['lib/u.mjs', 'main.js'])
        self.assertEqual(self.ns['read_plugin_file'](self.dir, 'P', 'data.json'), '{"a": 1}')
        self.assertEqual(base64.b64decode(self.ns['read_plugin_file'](self.dir, 'P', 'data.json', True)), b'{"a": 1}')
        with self.assertRaises(ValueError):
            self.ns['read_plugin_file'](self.dir, 'P', '../P/../../secret.txt')

    def test_new_plugin_gets_a_free_folder(self):
        files = {'plugin.json': '{"name": "My Tools"}', 'main.js': 'export function activate() {}'}
        a = self.ns['write_new_plugin'](self.dir, 'My Tools', files)
        b = self.ns['write_new_plugin'](self.dir, 'My Tools', files)
        c = self.ns['write_new_plugin'](self.dir, 'Bad:/\\Name*', files)
        self.assertEqual((a, b, c), ('My Tools', 'My Tools 2', 'BadName'))
        self.assertTrue(os.path.isfile(os.path.join(self.dir, 'My Tools 2', 'main.js')))
        with self.assertRaises(ValueError):
            self.ns['write_new_plugin'](self.dir, 'Evil', {'../escape.js': ''})

    def test_install_from_zip_with_or_without_a_top_folder(self):
        z1 = os.path.join(self.dir, 'one.zip')
        with zipfile.ZipFile(z1, 'w') as z:
            z.writestr('Generator/plugin.json', '{"name": "Generator"}')
            z.writestr('Generator/main.js', 'export function activate() {}')
            z.writestr('Generator/tables/sizes.json', '[]')
        z2 = os.path.join(self.dir, 'two.zip')
        with zipfile.ZipFile(z2, 'w') as z:
            z.writestr('plugin.json', '{"name": "Flat"}')
            z.writestr('main.js', '')
        z3 = os.path.join(self.dir, 'three.zip')
        with zipfile.ZipFile(z3, 'w') as z:
            z.writestr('readme.txt', 'no plug-in here')
        z4 = os.path.join(self.dir, 'four.zip')
        with zipfile.ZipFile(z4, 'w') as z:
            z.writestr('plugin.json', '{"name": "Slip"}')
            z.writestr('../../outside.js', '')
        dest = os.path.join(self.dir, 'Plugins')
        os.makedirs(dest)
        self.assertEqual(self.ns['install_plugin_zip'](dest, z1), 'Generator')
        self.assertTrue(os.path.isfile(os.path.join(dest, 'Generator', 'tables', 'sizes.json')))
        self.assertEqual(self.ns['install_plugin_zip'](dest, z2), 'Flat')
        with self.assertRaises(ValueError):
            self.ns['install_plugin_zip'](dest, z3)
        with self.assertRaises(ValueError):
            self.ns['install_plugin_zip'](dest, z4)
        self.assertFalse(os.path.exists(os.path.join(self.dir, 'outside.js')))


if __name__ == '__main__':
    unittest.main()
