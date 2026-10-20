"""Code-signs RazorCAD's Windows files (RazorCAD.exe, the thumbnail DLL, the setup) with signtool, once a
code-signing certificate is set up; until then it signs nothing and says so (the build carries on).

    python tools/sign.py <file> [<file> ...]      sign (or skip when not set up); exit 1 only on a failed signing
    python tools/sign.py --check                  say how signing is set up, and whether signtool is found
    python tools/sign.py --dry-run <file> ...     show the signtool command without running it
    python tools/sign.py --configured             exit 0 when files will be signed (set up, signtool found), else 2

Set up (see installer/SIGNING.md) with environment variables, or a signing.local.json next to build.bat
(kept out of git: it never holds a password):
    RAZORCAD_SIGN_THUMBPRINT   the certificate's SHA-1 thumbprint, in the Windows certificate store or on its
                               USB token / hardware key (the usual case: certificates are sold on tokens now)
    RAZORCAD_SIGN_PFX          or: a .pfx file, with its password in RAZORCAD_SIGN_PASSWORD
    RAZORCAD_SIGN_DLIB         or: a cloud signing service's signtool library (with RAZORCAD_SIGN_DMDF, its
                               metadata .json), e.g. Azure Trusted Signing
    RAZORCAD_SIGN_TIMESTAMP    timestamp server (default http://timestamp.digicert.com)
    RAZORCAD_SIGNTOOL          signtool.exe, when it is not in the Windows SDK's usual place
"""
import glob
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL = os.path.join(ROOT, 'signing.local.json')
KEYS = {  # setting → environment variable
    'thumbprint': 'RAZORCAD_SIGN_THUMBPRINT', 'pfx': 'RAZORCAD_SIGN_PFX', 'dlib': 'RAZORCAD_SIGN_DLIB',
    'dmdf': 'RAZORCAD_SIGN_DMDF', 'timestamp': 'RAZORCAD_SIGN_TIMESTAMP', 'signtool': 'RAZORCAD_SIGNTOOL',
}


def settings():
    s = {}
    if os.path.exists(LOCAL):
        with open(LOCAL, encoding='utf-8-sig') as f:
            s = {k: v for k, v in json.load(f).items() if k in KEYS and v}
    for k, env in KEYS.items():
        if os.environ.get(env):
            s[k] = os.environ[env]
    s.setdefault('timestamp', 'http://timestamp.digicert.com')
    return s


def mode(s):
    return 'thumbprint' if s.get('thumbprint') else 'pfx' if s.get('pfx') else 'dlib' if s.get('dlib') else None


def find_signtool(s):
    if s.get('signtool'):
        return s['signtool'] if os.path.exists(s['signtool']) else None
    base = os.path.join(os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)'), 'Windows Kits', '10', 'bin')
    # (the newest SDK first, 64-bit)
    found = sorted(glob.glob(os.path.join(base, '*', 'x64', 'signtool.exe')), reverse=True)
    found += glob.glob(os.path.join(base, 'x64', 'signtool.exe'))
    return found[0] if found else None


def command(tool, s, path):
    cmd = [tool, 'sign', '/fd', 'SHA256', '/tr', s['timestamp'], '/td', 'SHA256',
           '/d', 'RazorCAD', '/du', 'https://github.com/Labs9119/RazorCAD']
    m = mode(s)
    if m == 'thumbprint':
        cmd += ['/sha1', s['thumbprint'].replace(' ', '')]
    elif m == 'pfx':
        cmd += ['/f', s['pfx']]
        if os.environ.get('RAZORCAD_SIGN_PASSWORD'):
            cmd += ['/p', os.environ['RAZORCAD_SIGN_PASSWORD']]
    elif m == 'dlib':
        cmd += ['/dlib', s['dlib'], '/dmdf', s.get('dmdf', '')]
    return cmd + [path]


def shown(cmd):
    # (never print the password)
    return ' '.join('"***"' if i and cmd[i - 1] == '/p' else (f'"{a}"' if ' ' in a else a) for i, a in enumerate(cmd))


def main(argv):
    s = settings()
    dry = '--dry-run' in argv
    files = [a for a in argv if not a.startswith('--')]
    tool = find_signtool(s)
    if '--configured' in argv:
        return 0 if mode(s) and tool else 2
    if '--check' in argv:
        print(f'Signing: {mode(s) or "not set up (files are left unsigned)"}')
        print(f'signtool: {tool or "not found (install the Windows SDK, \'Signing Tools for Desktop Apps\')"}')
        print(f'Timestamp server: {s["timestamp"]}')
        return 0
    if not mode(s):
        for f in files:
            print(f'Not signed (no code-signing certificate set up): {os.path.basename(f)}')
        return 0
    if not tool and not dry:
        print('Signing is set up but signtool.exe was not found: install the Windows SDK ("Signing Tools for Desktop Apps") or set RAZORCAD_SIGNTOOL.')
        return 1
    for f in files:
        cmd = command(tool or 'signtool.exe', s, f)
        if dry:
            print(shown(cmd))
            continue
        # (a timestamp server can be busy: try it a few times)
        for attempt in range(3):
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode == 0:
                break
        if r.returncode != 0:
            print(f'Signing failed: {os.path.basename(f)}\n{r.stdout}{r.stderr}')
            return 1
        v = subprocess.run([tool, 'verify', '/pa', f], capture_output=True, text=True)
        if v.returncode != 0:
            print(f'Signed, but the signature does not verify: {os.path.basename(f)}\n{v.stdout}{v.stderr}')
            return 1
        print(f'Signed: {os.path.basename(f)}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
