# End-to-end test of the Explorer thumbnail (not shipped): registers the handler for a throwaway test
# extension (.rcadtest, never used by anything), asks the shell for a thumbnail as Explorer does, then
# removes every key it wrote. The real .rcad / .rasm / .rdrw settings are not touched.
import base64, io, json, os, subprocess, sys, types, winreg
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
T = os.path.join(HERE, 'e2e'); os.makedirs(T, exist_ok=True)
sys.modules['webview'] = types.SimpleNamespace(FileDialog=None)
sys.path.insert(0, ROOT)
import razorcad as p

CSC = os.path.join(os.environ['WINDIR'], r'Microsoft.NET\Framework64\v4.0.30319\csc.exe')
dll = os.path.join(T, 'RazorCADThumbs.dll')
subprocess.run([CSC, '/nologo', '/target:library', '/optimize+', '/out:' + dll, '/reference:System.Drawing.dll', os.path.join(HERE, 'RazorCADThumbs.cs')], check=True)
exe = os.path.join(T, 'ShellThumb.exe')
subprocess.run([CSC, '/nologo', '/target:exe', '/out:' + exe, '/reference:System.Drawing.dll', os.path.join(HERE, 'ShellThumb.cs')], check=True)

from PIL import Image, ImageDraw
im = Image.new('RGB', (400, 300), (197, 211, 226)); d = ImageDraw.Draw(im)
d.rectangle([80, 120, 320, 220], fill=(160, 170, 185), outline=(20, 24, 31), width=3); d.ellipse([160, 50, 240, 150], fill=(180, 188, 200), outline=(20, 24, 31), width=3)
b = io.BytesIO(); im.save(b, 'JPEG', quality=88)
test = os.path.join(T, 'Thumb Test.rcadtest')
with open(test, 'w', encoding='utf-8') as f:
    f.write(json.dumps({'thumbnail': 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode(), 'version': 1, 'name': 'T', 'equations': [], 'features': []}, indent=2))

CLS = r'Software\Classes\CLSID' + '\\' + p.THUMB_CLSID
EXT = r'Software\Classes\.rcadtest'


def delete_tree(root, path):
    try:
        with winreg.OpenKey(root, path) as k:
            subs, i = [], 0
            while True:
                try: subs.append(winreg.EnumKey(k, i)); i += 1
                except OSError: break
        for s in subs: delete_tree(root, path + '\\' + s)
        winreg.DeleteKey(root, path)
    except OSError:
        pass


existing = True
try: winreg.OpenKey(winreg.HKEY_CURRENT_USER, CLS)
except OSError: existing = False
try:
    # the CLSID exactly as register_thumbnails writes it, and the test extension's ShellEx
    import inspect
    src = inspect.getsource(p.register_thumbnails).split('    for ext, _, _ in FILE_TYPES:')[0] + '    return True\n'
    g = dict(vars(p)); exec(src, g); g['register_thumbnails'](dll)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, EXT + r'\ShellEx' + '\\' + p.THUMB_SHELLEX) as k:
        winreg.SetValueEx(k, '', 0, winreg.REG_SZ, p.THUMB_CLSID)
    r = subprocess.run([exe, test, '256', os.path.join(T, 'shell-thumb.png')], capture_output=True, text=True, timeout=120)
    print('shell thumbnail:', r.stdout.strip(), r.stderr.strip()[:400])
finally:
    delete_tree(winreg.HKEY_CURRENT_USER, EXT)
    if not existing:
        delete_tree(winreg.HKEY_CURRENT_USER, CLS)
    for key in (EXT, CLS if not existing else EXT):
        try: winreg.OpenKey(winreg.HKEY_CURRENT_USER, key); print('LEFT OVER', key)
        except OSError: pass
    print('test keys removed')
