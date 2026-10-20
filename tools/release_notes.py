"""Release notes for a RazorCAD version, from CHANGELOG.md: the entries added since the previous release (those not
in the changelog as it was at the previous version's tag), newest first.

    python tools/release_notes.py <version> [--since <previous tag>] [--out notes.md]

Without --since, the newest tag before this version's is used (git describe). The release workflow
(.github/workflows/release.yml) attaches the notes to the draft release; read them over before publishing it.
"""
import argparse
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEAD = re.compile(r'^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — (.+)$')


def entries(text):
    """The changelog's entries: [(header line, date, title, body)] in file order (newest first)."""
    out, cur = [], None
    for line in text.replace('\r\n', '\n').split('\n'):
        m = HEAD.match(line)
        if m:
            cur = [line, m.group(1), m.group(2), []]
            out.append(cur)
        elif cur is not None:
            cur[3].append(line)
    # (the regression-test lines are for the developers: left out)
    return [(h, d, t, '\n'.join(x for x in b if not x.startswith('- Regression test')).strip()) for h, d, t, b in out]


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, encoding='utf-8')


def previous_tag(tag):
    r = git('describe', '--tags', '--abbrev=0', f'{tag}^') if tag else git('describe', '--tags', '--abbrev=0')
    return r.stdout.strip() if r.returncode == 0 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('version')
    ap.add_argument('--since')
    ap.add_argument('--out')
    a = ap.parse_args()
    with open(os.path.join(ROOT, 'CHANGELOG.md'), encoding='utf-8') as f:
        now = entries(f.read())
    since = a.since or previous_tag('v' + a.version if git('rev-parse', '-q', '--verify', 'v' + a.version).returncode == 0 else None)
    old = set()
    if since:
        r = git('show', f'{since}:CHANGELOG.md')
        if r.returncode == 0:
            old = {h for h, _, _, _ in entries(r.stdout)}
    new = [e for e in now if e[0] not in old]
    lines = [f'# RazorCAD {a.version}', '']
    lines.append(f'What is new since {since}:' if since else 'What is new:')
    lines.append('')
    for _, _, title, body in new:
        lines.append(f'## {title}')
        if body:
            lines.append(body)
        lines.append('')
    lines += ['---', '', 'Install: download RazorCAD-Setup and run it (see "Read me first.txt"). Licensed under the GNU GPL v3 or later.', '']
    text = '\n'.join(lines)
    if a.out:
        with open(a.out, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
        print(f'{len(new)} entries -> {a.out}')
    else:
        sys.stdout.reconfigure(encoding='utf-8')
        print(text)


if __name__ == '__main__':
    main()
