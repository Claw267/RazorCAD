"""Update Now end to end, with real processes: python tests/update_e2e.py (Windows; needs PyInstaller).

Builds a small setup from installer/setup.py with stand-in programs in place of RazorCAD.exe, then runs it the way the
app and older versions do, on a throwaway folder. The setup's switches keep it out of the registry, the shortcuts and
any real installation, so this is safe on a PC that has RazorCAD installed. It checks that an update
  - survives the one-file program that started it closing, as RazorCAD does, with the flags RazorCAD uses,
  - waits for the running program to close, then replaces it, verifies it and starts the new one,
  - can be cancelled while it waits, leaving everything as it was,
  - still works through /S, which the helper of versions up to 0.21.5-beta runs.
"""
import ast
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
VERSION = '9.9.9-test'
CREATE_NO_WINDOW = 0x08000000
SYSTEM = Path(os.environ['SystemRoot']) / 'System32'
QUIET = ['/NOASSOC', '/NOENTRY']  # (nothing in the registry; an update makes no shortcuts)
# The older version in the update test, built as RazorCAD is (one file, no console): starts the setup with
# start_update's flags, stays until it has answered, and a little longer, as RazorCAD's closing does, then exits.
OLD_APP = '''import os, subprocess, sys, time
setup, status, folder = sys.argv[1:4]
flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | 0x08000000
subprocess.Popen([setup, '/UPDATE', '/D=' + folder, '/STATUS=' + status, '/NOASSOC', '/NOENTRY'], env=dict(os.environ, PYINSTALLER_RESET_ENVIRONMENT='1'),
                 creationflags=flags, close_fds=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
while not os.path.exists(status):
    time.sleep(0.1)
time.sleep(4)
'''


def razorcad_function(name):
    """One function of razorcad.py, which can't be imported without a desktop window."""
    tree = ast.parse((ROOT / 'razorcad.py').read_text(encoding='utf-8'))
    ns = dict(os=os, ctypes=ctypes, UPDATE_MUTEX='RazorCAD-Update')
    exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name], type_ignores=[]), 'razorcad.py', 'exec'), ns)
    return ns[name]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def freeze(script, name, work, *data):
    subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onefile', '--windowed', '--log-level', 'WARN', '--name', name, *data,
                    '--distpath', str(work), '--workpath', str(work / 'build' / name), '--specpath', str(work), str(script)], check=True)
    return work / (name + '.exe')


def build_setup(work):
    """The real setup code around a stand-in RazorCAD.exe (a copy of cmd.exe stays running when started)."""
    payload = work / 'payload'
    payload.mkdir()
    shutil.copyfile(SYSTEM / 'cmd.exe', payload / 'RazorCAD.exe')
    (payload / 'version.txt').write_text(VERSION + '\n', encoding='utf-8')
    for name in ('README.md', 'LICENSE.txt', 'THIRD-PARTY-NOTICES.md'):
        (payload / name).write_text('test', encoding='utf-8')
    shutil.copyfile(ROOT / 'assets' / 'razorcad.ico', payload / 'razorcad.ico')
    data = [arg for f in payload.iterdir() for arg in ('--add-data', '%s;payload' % f)]
    return freeze(ROOT / 'installer' / 'setup.py', 'RazorCAD-Setup-test', work, *data), payload / 'RazorCAD.exe'


def old_install(folder):
    """An installed older version, its program a copy of ping.exe."""
    folder.mkdir(parents=True)
    shutil.copyfile(SYSTEM / 'PING.EXE', folder / 'RazorCAD.exe')
    (folder / 'version.txt').write_text('0.0.1', encoding='utf-8')


def run_old(folder, seconds):
    return subprocess.Popen([str(folder / 'RazorCAD.exe'), '-n', str(seconds + 1), '127.0.0.1'], cwd=folder, creationflags=CREATE_NO_WINDOW,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def running(exe):
    try:
        with open(exe, 'r+b'):
            return False
    except OSError:
        return True


def stop(exe):
    """Stops that one program, by its full path: never another RazorCAD on this PC."""
    subprocess.run(['powershell', '-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:RC_EXE } | '
                    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'], env={**os.environ, 'RC_EXE': str(exe)}, check=True, creationflags=CREATE_NO_WINDOW)


def state_of(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def wait_for(check, seconds, what):
    deadline = time.time() + seconds
    while time.time() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError('Timed out: ' + what)


def test_update_from_a_closing_program(setup, new_exe, work):
    folder = work / "Jos\u00e9's RazorCAD [update]"
    old_install(folder)
    script = work / 'old_app.py'
    script.write_text(OLD_APP, encoding='utf-8')
    shutil.copyfile(freeze(script, 'old-app', work), folder / 'RazorCAD.exe')
    exe = folder / 'RazorCAD.exe'
    status = work / 'update-a.json'
    setup_running = razorcad_function('update_setup_running')
    assert not setup_running()
    old = subprocess.Popen([str(exe), str(setup), str(status), str(folder)], cwd=folder)
    wait_for(lambda: state_of(status).get('state') == 'waiting', 60, 'the setup to wait for the program')
    assert running(exe), 'the old program ended too soon for this test'
    assert setup_running(), 'RazorCAD would not see this update running'
    wait_for(lambda: state_of(status).get('state') == 'done', 60, 'the update to finish: %s' % state_of(status))
    assert old.poll() is not None
    assert sha(exe) == sha(new_exe), 'the program was not replaced'
    assert (folder / 'version.txt').read_text(encoding='utf-8').strip() == VERSION
    assert (folder / 'uninstall.exe').exists()
    wait_for(lambda: running(exe), 20, 'the new version to start')
    wait_for(lambda: not setup_running(), 20, 'the setup to finish')
    stop(exe)
    log = (work / 'update.log').read_text(encoding='utf-8')
    assert 'Verified replacement and restarted version ' + VERSION in log, log
    print('ok: survives the closing program, waits, replaces, verifies and restarts')


def test_cancel_while_waiting(setup, work):
    folder = work / 'cancel'
    old_install(folder)
    exe = folder / 'RazorCAD.exe'
    before = sha(exe)
    old = run_old(folder, 120)
    status = work / 'update-b.json'
    done = subprocess.Popen([str(setup), '/UPDATE', '/D=%s' % folder, '/STATUS=%s' % status, *QUIET], env={**os.environ, 'PYINSTALLER_RESET_ENVIRONMENT': '1'})
    wait_for(lambda: state_of(status).get('state') == 'waiting', 60, 'the setup to wait for the program')
    window = wait_for(lambda: ctypes.windll.user32.FindWindowW(None, 'RazorCAD Update'), 30, 'the update window')
    ctypes.windll.user32.PostMessageW(window, 0x0010, 0, 0)  # (WM_CLOSE: what its Cancel does)
    wait_for(lambda: state_of(status).get('state') == 'cancelled', 30, 'the cancel')
    done.wait(30)
    assert old.poll() is None and sha(exe) == before, 'a cancelled update changed something'
    assert (folder / 'version.txt').read_text(encoding='utf-8') == '0.0.1'
    stop(exe)
    print('ok: cancels while waiting, nothing changed')


def test_silent_install_of_older_helpers(setup, new_exe, work):
    folder = work / 'silent'
    old_install(folder)
    code = subprocess.run([str(setup), '/S', '/D=%s' % folder, '/NODESKTOP', '/NOSTARTMENU', *QUIET], env={**os.environ, 'PYINSTALLER_RESET_ENVIRONMENT': '1'}, timeout=120).returncode
    assert code == 0, code
    assert sha(folder / 'RazorCAD.exe') == sha(new_exe)
    assert (folder / 'version.txt').read_text(encoding='utf-8').strip() == VERSION
    print('ok: /S still installs')


def main():
    work = Path(tempfile.mkdtemp(prefix='razorcad-update-e2e-'))
    try:
        setup, new_exe = build_setup(work)
        print('built', setup.stat().st_size // 1024, 'KB')
        test_update_from_a_closing_program(setup, new_exe, work)
        test_cancel_while_waiting(setup, work)
        test_silent_install_of_older_helpers(setup, new_exe, work)
        print('ALL PASSED')
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
