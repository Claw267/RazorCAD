"""Updater handoff tests, runnable without a desktop GUI: python -m unittest discover -s tests -p test_updater.py.

Load only the updater definitions from the desktop entry point, so these checks also run on Linux
without importing pywebview or starting its HTTP server.
"""
import ast
import os
from pathlib import Path
import re
import shutil
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
            self.assertEqual(launch.call_args.args[0][-2], '-File')
            helper = Path(launch.call_args.args[0][-1])
            self.assertTrue(helper.read_bytes().startswith(b'\xef\xbb\xbf'))
            script = helper.read_text(encoding='utf-8-sig')
            self.assertIn('Get-Process -Id %d' % os.getpid(), script)
            self.assertLess(script.index('Wait-Process'), script.index('Start-Process'))
            self.assertIn("$expected = '1.0.0'", script)
            self.assertIn('$_.Path -eq $application', script)

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

    def test_helper_write_failure_does_not_close_the_application(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(tempfile, 'gettempdir', return_value=folder), \
                patch('builtins.open', side_effect=OSError('disk full')), patch.object(subprocess, 'Popen') as launch:
            result = self.start()
        self.assertNotIn('ok', result)
        self.assertIn('disk full', result['error'])
        launch.assert_not_called()

    def test_non_ascii_paths_survive_saved_helper(self):
        self.ns['install_info'].return_value['folder'] = "C:\\Users\\Jos\u00e9's Apps\\RazorCAD [test]"
        with tempfile.TemporaryDirectory() as folder, patch.object(tempfile, 'gettempdir', return_value=folder), \
                patch.object(subprocess, 'Popen') as launch:
            self.assertTrue(self.start()['ok'])
            script = Path(launch.call_args.args[0][-1]).read_text(encoding='utf-8-sig')
        self.assertIn("Jos\u00e9''s Apps", script)
        self.assertIn('Get-Content -LiteralPath $versionFile', script)

    def test_installer_failure_and_unchanged_binary_block_restart(self):
        script = self.ns['update_script']('setup.exe', 'C:\\Apps\\RazorCAD', False, 'update.log', 42, '1.0.0')
        restart = script.index('Start-Process -FilePath $application')
        for condition in ('$p.ExitCode -ne 0', '$before -eq $after', '$installed -ne $expected'):
            self.assertLess(script.index(condition), restart)
        self.assertIn('exit 1', script[script.index('function Fail-Update'):script.index('Write-UpdateLog (\'Starting')])
        self.assertIn('MessageBox]::Show', script)
        self.assertIn('PYINSTALLER_RESET_ENVIRONMENT', script[:restart])

    def test_powershell_handoff_success_and_failure_paths(self):
        shell = os.environ.get('RAZORCAD_TEST_PWSH') or shutil.which('pwsh') or shutil.which('powershell')
        if not shell:
            self.skipTest('PowerShell is needed to execute the helper; set RAZORCAD_TEST_PWSH')
        for mode in ('success', 'installer-error', 'setup-error', 'unchanged', 'wrong-version', 'launch-error', 'close-error'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="RazorCAD Jos\u00e9's [__PID__] ") as directory:
                folder = Path(directory)
                executable = folder / 'RazorCAD.exe'
                executable.write_text('old application')
                (folder / 'version.txt').write_text('0.9.0')
                marker = folder / 'restarted.txt'
                log = folder / 'update.log'
                script = self.ns['update_script'](str(folder / 'setup.exe'), str(folder), False, str(log), 42, '1.0.0')
                # Execute the real helper, hashing and reading actual files. Only
                # OS process/GUI calls are mocked: no installer or GUI is started.
                mocks = r'''
$script:polls = 0
function Get-Process {
    [CmdletBinding()] param([int]$Id, [string]$Name)
    if ($Id) { return [pscustomobject]@{ Id = $Id } }
    $script:polls++
    if ($script:polls -le 2) { return [pscustomobject]@{ Path = $application } }
}
function Wait-Process {
    [CmdletBinding()] param([Parameter(ValueFromPipeline=$true)]$InputObject, [int]$Timeout)
    if ($mode -eq 'close-error') { throw 'process did not close' }
}
function Start-Sleep { param([int]$Milliseconds) }
function Add-Type { param([string]$AssemblyName) throw 'No GUI in this test' }
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru, $Verb, $WorkingDirectory)
    if ($Wait) {
        if ($mode -eq 'setup-error') { throw 'Installer could not start (elevation cancelled)' }
        if ($mode -eq 'installer-error') { return [pscustomobject]@{ ExitCode = 5 } }
        if ($mode -ne 'unchanged') { [IO.File]::WriteAllText($application, 'new application') }
        $version = if ($mode -eq 'wrong-version') { '0.9.0' } else { '1.0.0' }
        [IO.File]::WriteAllText($versionFile, $version)
        return [pscustomobject]@{ ExitCode = 0 }
    }
    if ($mode -eq 'launch-error') { throw 'launch failed' }
    [IO.File]::WriteAllText($marker, [string]$script:polls)
}
'''
                q = lambda value: "'" + str(value).replace("'", "''") + "'"
                helper = folder / 'test-helper.ps1'
                helper.write_text('$mode = %s\n$marker = %s\n' % (q(mode), q(marker)) + mocks + script, encoding='utf-8-sig')
                result = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(helper)],
                                        capture_output=True, text=True, timeout=30,
                                        env={**os.environ, 'XDG_CACHE_HOME': str(folder / 'cache'), 'XDG_CONFIG_HOME': str(folder / 'config'),
                                             'XDG_DATA_HOME': str(folder / 'data')})
                output = log.read_text(encoding='utf-8-sig') if log.exists() else result.stderr
                if mode == 'success':
                    self.assertEqual(result.returncode, 0, output + result.stderr)
                    self.assertGreaterEqual(int(marker.read_text()), 3, 'Did not wait for the frozen parent')
                    self.assertIn('Verified replacement', output)
                else:
                    self.assertNotEqual(result.returncode, 0, output)
                    self.assertFalse(marker.exists(), 'Restarted after failed verification')
                    self.assertIn('FAILED:', output)


if __name__ == '__main__':
    unittest.main()
