"""RazorCAD Setup — installs RazorCAD (and what it needs) on Windows.

Built into a single RazorCAD-Setup-<version>.exe by build_installer.bat, with RazorCAD.exe inside it.

    RazorCAD-Setup.exe                 setup wizard
    RazorCAD-Setup.exe /S [/D=folder] [/ALLUSERS] [/NODESKTOP] [/NOASSOC]   silent install
    uninstall.exe (copied into the install folder; also run from Windows' Installed apps)

What it installs:
  * RazorCAD.exe (self-contained: Python, the user interface and the OpenCascade kernel are inside)
  * Microsoft Edge WebView2 Runtime, if missing (RazorCAD draws its window with it; Windows 11 and
    up-to-date Windows 10 already have it) - Microsoft's official installer, downloaded when needed
  * .NET Framework 4.7.2 or later, if missing (used by the window layer; Windows 10 1803+ has it)
  * Start-menu / desktop shortcuts and an entry in Windows' Installed apps (with an uninstaller)
  * .rcad / .rasm / .rdrw files (parts, assemblies, drawings) opening with RazorCAD (optional)
"""
import ctypes
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
import winreg

APP = 'RazorCAD'
PUBLISHER = 'RazorCAD'
WEBVIEW2_ID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
WEBVIEW2_URL = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'   # Evergreen bootstrapper (Microsoft)
DOTNET48_URL = 'https://go.microsoft.com/fwlink/?LinkId=2085155'      # .NET Framework 4.8 web installer (Microsoft)
DOTNET_MIN_RELEASE = 461808                                          # 4.7.2
UNINSTALL_KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\RazorCAD'
CREATE_NO_WINDOW = 0x08000000
# RazorCAD's file types (the same as razorcad.py's FILE_TYPES)
FILE_TYPES = (('.rcad', 'RazorCAD.Part', 'RazorCAD Part'),
              ('.rasm', 'RazorCAD.Assembly', 'RazorCAD Assembly'),
              ('.rdrw', 'RazorCAD.Drawing', 'RazorCAD Drawing'))
# Explorer previews of those files (shell/RazorCADThumbs.cs, the same as razorcad.py's)
THUMB_CLSID = '{4F6B9D2E-7C1A-4E58-9B3D-2A61C0E5F7A1}'
THUMB_SHELLEX = '{e357fccd-a995-4576-b01f-234630154e96}'


def register_thumbnails(dll, all_users):
    root = winreg.HKEY_LOCAL_MACHINE if all_users else winreg.HKEY_CURRENT_USER
    cls = r'Software\Classes\CLSID' + '\\' + THUMB_CLSID
    vals = {'': 'mscoree.dll', 'ThreadingModel': 'Both', 'Class': 'RazorCAD.Shell.ThumbnailProvider',
            'Assembly': 'RazorCADThumbs, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null',
            'RuntimeVersion': 'v4.0.30319', 'CodeBase': 'file:///' + dll.replace('\\', '/')}
    with winreg.CreateKey(root, cls) as k:
        winreg.SetValueEx(k, '', 0, winreg.REG_SZ, 'RazorCAD Thumbnail Provider')
    for sub in (r'\InprocServer32', r'\InprocServer32\1.0.0.0'):
        with winreg.CreateKey(root, cls + sub) as k:
            for name, val in vals.items():
                if sub.endswith('1.0.0.0') and name in ('', 'ThreadingModel'):
                    continue
                winreg.SetValueEx(k, name, 0, winreg.REG_SZ, val)
    with winreg.CreateKey(root, cls + r'\Implemented Categories\{62C8FE65-4EBB-45e7-B440-6E39B2CDBF29}'):
        pass
    for ext, _, _ in FILE_TYPES:
        for base in (r'Software\Classes' + '\\' + ext, r'Software\Classes\SystemFileAssociations' + '\\' + ext):
            with winreg.CreateKey(root, base + r'\ShellEx' + '\\' + THUMB_SHELLEX) as k:
                winreg.SetValueEx(k, '', 0, winreg.REG_SZ, THUMB_CLSID)


def register_file_types(exe, all_users):
    root = winreg.HKEY_LOCAL_MACHINE if all_users else winreg.HKEY_CURRENT_USER
    base = r'Software\Classes'
    for ext, progid, desc in FILE_TYPES:
        for sub, val in (('', desc), (r'\DefaultIcon', f'"{exe}",0'), (r'\shell\open\command', f'"{exe}" "%1"')):
            with winreg.CreateKey(root, base + '\\' + progid + sub) as k:
                winreg.SetValueEx(k, '', 0, winreg.REG_SZ, val)
        with winreg.CreateKey(root, base + '\\' + ext) as k:
            winreg.SetValueEx(k, '', 0, winreg.REG_SZ, progid)
        with winreg.CreateKey(root, base + '\\' + ext + r'\OpenWithProgids') as k:
            winreg.SetValueEx(k, progid, 0, winreg.REG_SZ, '')
    notify_assoc_changed()


def delete_tree(root, path):
    try:
        with winreg.OpenKey(root, path) as k:
            subs = []
            i = 0
            while True:
                try:
                    subs.append(winreg.EnumKey(k, i))
                    i += 1
                except OSError:
                    break
        for sub in subs:
            delete_tree(root, path + '\\' + sub)
        winreg.DeleteKey(root, path)
    except OSError:
        pass


def unregister_file_types(all_users):
    """Remove RazorCAD's file types (the extensions are left alone when they now belong to another program)."""
    for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER) if all_users else (winreg.HKEY_CURRENT_USER,):
        base = r'Software\Classes'
        delete_tree(root, base + r'\CLSID' + '\\' + THUMB_CLSID)
        for ext, progid, _ in FILE_TYPES:
            delete_tree(root, base + '\\' + ext + r'\ShellEx' + '\\' + THUMB_SHELLEX)
            delete_tree(root, base + r'\SystemFileAssociations' + '\\' + ext + r'\ShellEx' + '\\' + THUMB_SHELLEX)
            delete_tree(root, base + '\\' + progid)
            try:
                with winreg.OpenKey(root, base + '\\' + ext + r'\OpenWithProgids', 0, winreg.KEY_ALL_ACCESS) as k:
                    winreg.DeleteValue(k, progid)
            except OSError:
                pass
            try:
                with winreg.OpenKey(root, base + '\\' + ext) as k:
                    ours = winreg.QueryValueEx(k, '')[0] == progid
            except OSError:
                ours = False
            if ours:
                delete_tree(root, base + '\\' + ext)
    notify_assoc_changed()


def notify_assoc_changed():
    try:
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)  # SHCNE_ASSOCCHANGED
    except Exception:
        pass


def bundle_dir():
    return getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))


def payload(name):
    return os.path.join(bundle_dir(), 'payload', name)


def version():
    try:
        with open(payload('version.txt'), encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return '0.0'


def is_admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def default_dir(all_users):
    if all_users:
        return os.path.join(os.environ.get('ProgramW6432') or os.environ.get('ProgramFiles', r'C:\Program Files'), APP)
    return os.path.join(os.environ['LOCALAPPDATA'], 'Programs', APP)


def existing_install():
    """(folder, all_users) of an earlier installation, if any."""
    for root, all_users in ((winreg.HKEY_CURRENT_USER, False), (winreg.HKEY_LOCAL_MACHINE, True)):
        try:
            with winreg.OpenKey(root, UNINSTALL_KEY) as k:
                return winreg.QueryValueEx(k, 'InstallLocation')[0], all_users
        except OSError:
            continue
    return None, False


# ------------------------------------------------------------ prerequisites
def webview2_version():
    keys = [
        (winreg.HKEY_LOCAL_MACHINE, rf'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_ID}'),
        (winreg.HKEY_LOCAL_MACHINE, rf'SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_ID}'),
        (winreg.HKEY_CURRENT_USER, rf'Software\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_ID}'),
    ]
    for root, path in keys:
        try:
            with winreg.OpenKey(root, path) as k:
                v = winreg.QueryValueEx(k, 'pv')[0]
                if v and v != '0.0.0.0':
                    return v
        except OSError:
            continue
    return None


def dotnet_release():
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full') as k:
            return int(winreg.QueryValueEx(k, 'Release')[0])
    except OSError:
        return 0


def download(url, name, log, progress):
    target = os.path.join(tempfile.mkdtemp(prefix='razorcad-setup-'), name)
    log(f'Downloading {name} from Microsoft…')

    def hook(blocks, size, total):
        if total > 0:
            progress(min(1.0, blocks * size / total))

    urllib.request.urlretrieve(url, target, hook)
    return target


# ------------------------------------------------------------ install / uninstall
def shell_folder(name):
    """A Windows known folder (Desktop, CommonDesktopDirectory, Programs, CommonPrograms)."""
    out = subprocess.run(['powershell', '-NoProfile', '-Command', f"[Environment]::GetFolderPath('{name}')"],
                         capture_output=True, text=True, creationflags=CREATE_NO_WINDOW)
    return out.stdout.strip()


def make_shortcut(lnk, target, workdir, icon):
    env = {**os.environ, 'PC_LNK': lnk, 'PC_TARGET': target, 'PC_DIR': workdir, 'PC_ICON': icon}
    script = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:PC_LNK);"
              "$s.TargetPath=$env:PC_TARGET;$s.WorkingDirectory=$env:PC_DIR;$s.IconLocation=$env:PC_ICON;"
              "$s.Description='RazorCAD parametric CAD';$s.Save()")
    subprocess.run(['powershell', '-NoProfile', '-Command', script], env=env, check=True, creationflags=CREATE_NO_WINDOW)


def shortcut_paths(all_users):
    programs = shell_folder('CommonPrograms' if all_users else 'Programs')
    desktop = shell_folder('CommonDesktopDirectory' if all_users else 'Desktop')
    return os.path.join(programs, f'{APP}.lnk'), os.path.join(desktop, f'{APP}.lnk')


def install(opts, log, progress):
    """opts: dir, all_users, desktop, startmenu. log(text), progress(0..1 or None)."""
    folder = opts['dir']
    # 1. prerequisites
    log('Checking the Microsoft Edge WebView2 Runtime…')
    v = webview2_version()
    if v:
        log(f'  WebView2 Runtime {v} is installed.')
    else:
        exe = download(WEBVIEW2_URL, 'MicrosoftEdgeWebview2Setup.exe', log, progress)
        log('Installing the WebView2 Runtime (this can take a minute)…')
        progress(None)
        r = subprocess.run([exe, '/silent', '/install'])
        if not webview2_version():
            raise RuntimeError(f'The WebView2 Runtime could not be installed (code {r.returncode}). '
                               'Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and run setup again.')
        log('  WebView2 Runtime installed.')
    log('Checking the .NET Framework…')
    if dotnet_release() >= DOTNET_MIN_RELEASE:
        log('  .NET Framework 4.7.2 or later is installed.')
    else:
        exe = download(DOTNET48_URL, 'ndp48-web.exe', log, progress)
        log('Installing .NET Framework 4.8 (Windows may ask for permission; this can take several minutes)…')
        progress(None)
        r = subprocess.run([exe, '/passive', '/norestart'])
        if dotnet_release() < DOTNET_MIN_RELEASE:
            raise RuntimeError(f'.NET Framework 4.8 could not be installed (code {r.returncode}). Install it from Microsoft and run setup again.')
        log('  .NET Framework installed' + (' — Windows may need a restart.' if r.returncode in (1641, 3010) else '.'))

    # 2. files
    log(f'Installing RazorCAD to {folder}…')
    progress(0.0)
    os.makedirs(folder, exist_ok=True)
    target = os.path.join(folder, f'{APP}.exe')
    try:
        if os.path.exists(target):
            os.replace(target, target + '.old')  # works even if an old copy is running
    except OSError:
        raise RuntimeError('RazorCAD is running from the install folder. Close RazorCAD and run setup again.')
    files = [('RazorCAD.exe', target), ('razorcad.ico', os.path.join(folder, 'razorcad.ico')),
             ('README.md', os.path.join(folder, 'README.md')), ('version.txt', os.path.join(folder, 'version.txt'))]
    thumbs = os.path.join(folder, 'RazorCADThumbs.dll')
    if os.path.isfile(payload('RazorCADThumbs.dll')):
        try:
            if os.path.exists(thumbs):
                os.replace(thumbs, thumbs + '.old')  # (Explorer may have it loaded)
        except OSError:
            pass
        files.append(('RazorCADThumbs.dll', thumbs))
    for i, (src, dst) in enumerate(files):
        shutil.copyfile(payload(src), dst)
        progress((i + 1) / (len(files) + 1))
    for old in (target + '.old', thumbs + '.old'):
        try:
            os.remove(old)
        except OSError:
            pass  # still running: removed by the next setup
    uninstaller = os.path.join(folder, 'uninstall.exe')
    if getattr(sys, 'frozen', False):
        shutil.copyfile(sys.executable, uninstaller)
    progress(1.0)

    # 3. shortcuts
    menu_lnk, desk_lnk = shortcut_paths(opts['all_users'])
    icon = os.path.join(folder, 'razorcad.ico')
    if opts['startmenu']:
        log('Creating the Start-menu shortcut…')
        make_shortcut(menu_lnk, target, folder, icon)
    if opts['desktop']:
        log('Creating the desktop shortcut…')
        make_shortcut(desk_lnk, target, folder, icon)

    # 4. file types
    if opts.get('assoc', True):
        log('Making .rcad / .rasm / .rdrw files open with RazorCAD…')
        register_file_types(target, opts['all_users'])
        if os.path.isfile(thumbs):
            log('Turning on their previews in Explorer…')
            register_thumbnails(thumbs, opts['all_users'])
            notify_assoc_changed()

    # 5. Installed apps entry
    log('Registering RazorCAD in Installed apps…')
    root = winreg.HKEY_LOCAL_MACHINE if opts['all_users'] else winreg.HKEY_CURRENT_USER
    size_kb = sum(os.path.getsize(os.path.join(folder, f)) for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f))) // 1024
    with winreg.CreateKey(root, UNINSTALL_KEY) as k:
        for name, val in (('DisplayName', f'{APP} {version()}'), ('DisplayVersion', version()), ('Publisher', PUBLISHER),
                          ('InstallLocation', folder), ('DisplayIcon', icon),
                          ('UninstallString', f'"{uninstaller}"'), ('QuietUninstallString', f'"{uninstaller}" /S')):
            winreg.SetValueEx(k, name, 0, winreg.REG_SZ, val)
        for name, val in (('NoModify', 1), ('NoRepair', 1), ('EstimatedSize', size_kb)):
            winreg.SetValueEx(k, name, 0, winreg.REG_DWORD, val)
    log('Done.')
    return target


def uninstall(remove_user_data, log=print):
    folder, all_users = existing_install()
    if not folder:
        folder = os.path.dirname(sys.executable)
    target = os.path.join(folder, f'{APP}.exe')
    try:
        if os.path.exists(target):
            os.remove(target)
    except OSError:
        raise RuntimeError('RazorCAD is running. Close it and try again.')
    for name in ('razorcad.ico', 'README.md', 'version.txt', f'{APP}.exe.old', 'RazorCADThumbs.dll', 'RazorCADThumbs.dll.old'):
        try:
            os.remove(os.path.join(folder, name))
        except OSError:
            pass
    for lnk in shortcut_paths(all_users):
        try:
            os.remove(lnk)
        except OSError:
            pass
    root = winreg.HKEY_LOCAL_MACHINE if all_users else winreg.HKEY_CURRENT_USER
    try:
        winreg.DeleteKey(root, UNINSTALL_KEY)
    except OSError:
        pass
    unregister_file_types(all_users)
    if remove_user_data:
        shutil.rmtree(os.path.join(os.environ.get('APPDATA', ''), APP), ignore_errors=True)
    # uninstall.exe can't delete itself while it runs: remove it (and the folder) just after it exits
    me = os.path.join(folder, 'uninstall.exe')
    subprocess.Popen(f'cmd /c ping 127.0.0.1 -n 3 >nul & del /f /q "{me}" & rmdir "{folder}"',
                     creationflags=CREATE_NO_WINDOW, close_fds=True)
    log('RazorCAD was removed.')


def relaunch_elevated(args):
    params = ' '.join(f'"{a}"' for a in args)
    exe = sys.executable
    script = '' if getattr(sys, 'frozen', False) else f'"{os.path.abspath(__file__)}" '
    r = ctypes.windll.shell32.ShellExecuteW(None, 'runas', exe, script + params, None, 1)
    return r > 32


# ------------------------------------------------------------ user interface
def run_wizard(start_opts=None):
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox

    old_dir, old_all = existing_install()
    root = tk.Tk()
    root.title(f'{APP} {version()} Setup')
    root.geometry('620x430')
    root.resizable(False, False)
    try:
        root.iconbitmap(payload('razorcad.ico'))
    except Exception:
        pass
    style = ttk.Style()
    try:
        style.theme_use('vista')
    except tk.TclError:
        pass
    style.configure('Title.TLabel', font=('Segoe UI', 15, 'bold'))
    style.configure('Body.TLabel', font=('Segoe UI', 10), wraplength=540)

    state = {
        'all_users': tk.BooleanVar(value=start_opts['all_users'] if start_opts else old_all),
        'dir': tk.StringVar(value=start_opts['dir'] if start_opts else (old_dir or default_dir(False))),
        'desktop': tk.BooleanVar(value=start_opts['desktop'] if start_opts else True),
        'startmenu': tk.BooleanVar(value=start_opts['startmenu'] if start_opts else True),
        'assoc': tk.BooleanVar(value=start_opts.get('assoc', True) if start_opts else True),
        'launch': tk.BooleanVar(value=True),
    }
    header = tk.Frame(root, bg='#26303c', height=64)
    header.pack(fill='x')
    tk.Label(header, text='R', bg='#c62828', fg='white', font=('Segoe UI', 18, 'bold'), width=2).place(x=18, y=12, height=40)
    tk.Label(header, text=f'{APP} {version()}', bg='#26303c', fg='white', font=('Segoe UI', 14, 'bold')).place(x=66, y=8)
    tk.Label(header, text='Parametric part modeling', bg='#26303c', fg='#b9c3cf', font=('Segoe UI', 9)).place(x=67, y=36)
    body = ttk.Frame(root, padding=(24, 18))
    body.pack(fill='both', expand=True)
    footer = ttk.Frame(root, padding=(16, 10))
    footer.pack(fill='x', side='bottom')
    ttk.Separator(root).pack(fill='x', side='bottom')
    back_btn = ttk.Button(footer, text='< Back')
    next_btn = ttk.Button(footer, text='Next >')
    cancel_btn = ttk.Button(footer, text='Cancel', command=root.destroy)
    cancel_btn.pack(side='right', padx=(6, 0))
    next_btn.pack(side='right')
    back_btn.pack(side='right', padx=(0, 6))

    def clear():
        for w in body.winfo_children():
            w.destroy()

    def page_welcome():
        clear()
        ttk.Label(body, text=f'Welcome to {APP} Setup', style='Title.TLabel').pack(anchor='w')
        upgrade = f'\n\n{APP} is already installed in {old_dir}; setup will update it.' if old_dir else ''
        ttk.Label(body, style='Body.TLabel', text=(
            f'This installs {APP} {version()}, a parametric 3D part modeler, on this computer, together with the '
            'Microsoft components it needs if they are missing (the Edge WebView2 Runtime and the .NET Framework).'
            f'{upgrade}\n\nClick Next to continue.')).pack(anchor='w', pady=(12, 0))
        back_btn.state(['disabled'])
        next_btn.configure(text='Next >', command=page_location)
        next_btn.state(['!disabled'])

    def page_location():
        clear()
        ttk.Label(body, text='Install location', style='Title.TLabel').pack(anchor='w')
        who = ttk.Frame(body)
        who.pack(anchor='w', pady=(12, 4))

        def set_who():
            d = state['dir'].get()
            if d in (default_dir(True), default_dir(False)) or not d:
                state['dir'].set(default_dir(state['all_users'].get()))

        ttk.Radiobutton(who, text='Just for me (no administrator rights needed)', variable=state['all_users'], value=False, command=set_who).pack(anchor='w')
        ttk.Radiobutton(who, text='For everyone on this computer (needs administrator rights)', variable=state['all_users'], value=True, command=set_who).pack(anchor='w')
        ttk.Label(body, text='Folder:', style='Body.TLabel').pack(anchor='w', pady=(10, 2))
        row = ttk.Frame(body)
        row.pack(fill='x')
        ttk.Entry(row, textvariable=state['dir']).pack(side='left', fill='x', expand=True)

        def browse():
            d = filedialog.askdirectory(initialdir=os.path.dirname(state['dir'].get()) or None, title='Choose the install folder')
            if d:
                d = os.path.normpath(d)
                state['dir'].set(d if os.path.basename(d).lower() == APP.lower() else os.path.join(d, APP))

        ttk.Button(row, text='Browse…', command=browse).pack(side='left', padx=(6, 0))
        opts = ttk.Frame(body)
        opts.pack(anchor='w', pady=(14, 0))
        ttk.Checkbutton(opts, text='Create a desktop shortcut', variable=state['desktop']).pack(anchor='w')
        ttk.Checkbutton(opts, text='Create a Start-menu shortcut', variable=state['startmenu']).pack(anchor='w')
        ttk.Checkbutton(opts, text='Open .rcad, .rasm and .rdrw files with RazorCAD', variable=state['assoc']).pack(anchor='w')
        ttk.Label(body, style='Body.TLabel', text='About 25 MB of disk space is needed.').pack(anchor='w', pady=(14, 0))
        back_btn.state(['!disabled'])
        back_btn.configure(command=page_welcome)
        next_btn.configure(text='Install', command=start_install)

    def start_install():
        opts = {k: v.get() for k, v in state.items()}
        opts['dir'] = os.path.normpath(opts['dir'].strip())
        if not opts['dir'] or not os.path.isabs(opts['dir']):
            messagebox.showerror('Setup', 'Choose a full folder path, for example C:\\Programs\\RazorCAD.')
            return
        if opts['all_users'] and not is_admin():
            args = ['/ELEVATED', f'/D={opts["dir"]}', '/ALLUSERS'] + ([] if opts['desktop'] else ['/NODESKTOP']) + ([] if opts['startmenu'] else ['/NOSTARTMENU']) + ([] if opts['assoc'] else ['/NOASSOC'])
            if relaunch_elevated(args):
                root.destroy()
            else:
                messagebox.showwarning('Setup', 'Administrator rights were not granted. Choose "Just for me" to install without them.')
            return
        page_progress(opts)

    def page_progress(opts):
        clear()
        ttk.Label(body, text='Installing…', style='Title.TLabel').pack(anchor='w')
        status = ttk.Label(body, style='Body.TLabel', text='Starting…')
        status.pack(anchor='w', pady=(10, 4))
        bar = ttk.Progressbar(body, mode='determinate', maximum=1000)
        bar.pack(fill='x')
        logbox = tk.Text(body, height=9, font=('Consolas', 9), relief='solid', borderwidth=1, bg='#f7f8fa')
        logbox.pack(fill='both', expand=True, pady=(10, 0))
        for b in (back_btn, next_btn, cancel_btn):
            b.state(['disabled'])
        q = queue.Queue()

        def worker():
            try:
                exe = install(opts, lambda t: q.put(('log', t)), lambda p: q.put(('progress', p)))
                q.put(('done', exe))
            except Exception as e:
                q.put(('error', str(e)))

        def poll():
            try:
                while True:
                    kind, val = q.get_nowait()
                    if kind == 'log':
                        status.configure(text=val.strip())
                        logbox.insert('end', val + '\n')
                        logbox.see('end')
                    elif kind == 'progress':
                        if val is None:
                            bar.configure(mode='indeterminate')
                            bar.start(12)
                        else:
                            bar.stop()
                            bar.configure(mode='determinate', value=val * 1000)
                    elif kind == 'done':
                        return page_finish(val)
                    elif kind == 'error':
                        bar.stop()
                        messagebox.showerror('Setup', val)
                        cancel_btn.state(['!disabled'])
                        cancel_btn.configure(text='Close')
                        return
            except queue.Empty:
                pass
            root.after(80, poll)

        threading.Thread(target=worker, daemon=True).start()
        poll()

    def page_finish(exe):
        clear()
        ttk.Label(body, text=f'{APP} is installed', style='Title.TLabel').pack(anchor='w')
        ttk.Label(body, style='Body.TLabel', text=(
            f'{APP} was installed in {os.path.dirname(exe)}.\n\nStart it from the Start menu or the desktop shortcut. '
            'To remove it later, use Windows Settings ▸ Apps ▸ Installed apps.\n\nIf something goes wrong while you '
            'test, RazorCAD saves a crash report: Help ▸ Open Crash Reports Folder.')).pack(anchor='w', pady=(12, 0))
        ttk.Checkbutton(body, text=f'Start {APP} now', variable=state['launch']).pack(anchor='w', pady=(16, 0))

        def finish():
            if state['launch'].get():
                subprocess.Popen([exe], cwd=os.path.dirname(exe), close_fds=True)
            root.destroy()

        back_btn.state(['disabled'])
        cancel_btn.state(['disabled'])
        next_btn.state(['!disabled'])
        next_btn.configure(text='Finish', command=finish)

    if start_opts:
        page_progress(start_opts)  # elevated relaunch: go straight to installing
    else:
        page_welcome()
    root.mainloop()


def run_uninstaller(silent):
    _, all_users = existing_install()
    if all_users and not is_admin():
        relaunch_elevated(['/UNINSTALL'] + (['/S'] if silent else []))  # Program Files needs administrator rights
        return
    if silent:
        uninstall(False)
        return
    import tkinter as tk
    from tkinter import messagebox
    root = tk.Tk()
    root.withdraw()
    try:
        root.iconbitmap(payload('razorcad.ico'))
    except Exception:
        pass
    if not messagebox.askyesno(f'Uninstall {APP}', f'Remove {APP} from this computer?'):
        return
    data = messagebox.askyesno(f'Uninstall {APP}', 'Also remove your RazorCAD settings, recent-files list and crash reports?\n\n'
                               '(Your part files are never removed.)', default='no')
    try:
        uninstall(data)
        messagebox.showinfo(f'Uninstall {APP}', f'{APP} was removed.')
    except Exception as e:
        messagebox.showerror(f'Uninstall {APP}', str(e))


def main():
    args = sys.argv[1:]
    flags = {a.upper() for a in args if not a.upper().startswith('/D=')}
    folder = next((a[3:] for a in args if a.upper().startswith('/D=')), None)
    name = os.path.basename(sys.executable).lower()
    if '/UNINSTALL' in flags or name.startswith('uninstall'):
        return run_uninstaller('/S' in flags)
    all_users = '/ALLUSERS' in flags
    opts = {'dir': folder or existing_install()[0] or default_dir(all_users), 'all_users': all_users,
            'desktop': '/NODESKTOP' not in flags, 'startmenu': '/NOSTARTMENU' not in flags, 'assoc': '/NOASSOC' not in flags, 'launch': False}
    if '/S' in flags:
        if all_users and not is_admin():
            print('Installing for all users needs administrator rights.')
            sys.exit(2)
        install(opts, print, lambda p: None)
        return
    run_wizard(opts if '/ELEVATED' in flags else None)


if __name__ == '__main__':
    main()
