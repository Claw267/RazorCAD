"""Updater handoff tests, runnable without a desktop GUI: python -m unittest discover -s tests -p test_updater.py.

Load only the updater definitions from the desktop entry point, so these checks also run on Linux
without importing pywebview or starting its HTTP server.
"""
import ast
import os
from pathlib import Path
import re
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


def updater_namespace():
    source = ast.parse((Path(__file__).resolve().parents[1] / 'razorcad.py').read_text(encoding='utf-8'))
    script = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'update_script')
    api = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'Api')
    start = next(n for n in api.body if isinstance(n, ast.FunctionDef) and n.name == 'start_update')
    ns = dict(os=os, re=re, subprocess=subprocess, APP_NAME='RazorCAD', NO_WINDOW=0,
              RELEASE_DOWNLOADS='https://github.com/Labs9119/RazorCAD/releases/download/',
              install_info=Mock(return_value={'installed': True, 'folder': r'C:\Apps\RazorCAD', 'allUsers': False}),
              download_verified=Mock())
    exec(compile(ast.Module(body=[script, start], type_ignores=[]), 'razorcad.py', 'exec'), ns)
    return ns


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.ns = updater_namespace()
        self.url = self.ns['RELEASE_DOWNLOADS'] + 'v1.0.0/RazorCAD-Setup-1.0.0.exe'

    def start(self):
        return self.ns['start_update'](types.SimpleNamespace(), self.url, 123, 'sha256:abc')

    def test_restart_resets_frozen_environment_without_changing_parent(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            '_PYI_APPLICATION_HOME_DIR': 'old-extracted-bundle', 'PYINSTALLER_RESET_ENVIRONMENT': '0'
        }), patch.object(tempfile, 'gettempdir', return_value=folder), patch.object(subprocess, 'Popen') as launch:
            self.assertTrue(self.start()['ok'])
            child_env = launch.call_args.kwargs['env']
            self.assertEqual(child_env['PYINSTALLER_RESET_ENVIRONMENT'], '1')
            self.assertEqual(os.environ['PYINSTALLER_RESET_ENVIRONMENT'], '0')
            script = launch.call_args.args[0][-1]
            self.assertIn('Get-Process -Id %d' % os.getpid(), script)
            self.assertLess(script.index('Wait-Process'), script.index('Start-Process'))

    def test_helper_failure_keeps_application_open(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(tempfile, 'gettempdir', return_value=folder), \
                patch.object(subprocess, 'Popen', side_effect=OSError('PowerShell missing')):
            result = self.start()
        self.assertNotIn('ok', result)
        self.assertIn('PowerShell missing', result['error'])

    def test_download_failure_does_not_launch_installer(self):
        self.ns['download_verified'].side_effect = OSError('incomplete download')
        with tempfile.TemporaryDirectory() as folder, patch.object(tempfile, 'gettempdir', return_value=folder), \
                patch.object(subprocess, 'Popen') as launch:
            self.assertIn('Download failed', self.start()['error'])
            launch.assert_not_called()

    def test_elevation_and_quoted_install_path(self):
        script = self.ns['update_script']('setup.exe', "C:\\John's Apps\\RazorCAD", True, 'update.log', 42)
        self.assertIn('-Verb RunAs', script)
        self.assertIn("'/ALLUSERS'", script)
        self.assertIn('John\'\'s Apps', script)
        self.assertIn('exit 1', script[:script.index('Start-Process')])


if __name__ == '__main__':
    unittest.main()
