"""Report what has changed in RazorCAD since the manual was last brought up to date.

    python check_changes.py            print a report (JSON) and write it to .tracking/last_report.json
    python check_changes.py --accept   record the current state as the new baseline (run after the
                                       manual has been updated)

What it compares against the baseline in .tracking/:
  - every project file (SHA-256), outside the Manual folder and build output
  - version.txt
  - the UI surface: menu, toolbar and command labels found in the app's JavaScript, so new, renamed
    or removed commands show up even inside large files
  - full text diffs of the documentation files (README.md and everything in "Change Requests")
  - text diffs of the source code (app/js, app/css, app/index.html, razorcad.py), so the daily update
    can read exactly what changed
"""
import difflib
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
TRACK = HERE / ".tracking"
BASE = TRACK / "baseline.json"
DOCS_COPY = TRACK / "docs"
CODE_COPY = TRACK / "code"
REPORT = TRACK / "last_report.json"

SKIP_DIRS = {"Manual", ".git", "__pycache__", "build", "dist", "node_modules", ".venv"}
SKIP_SUFFIX = {".pyc", ".log"}
DOC_FILES = lambda: [PROJECT / "README.md"] + sorted((PROJECT / "Change Requests").glob("*.txt")) + \
    sorted((PROJECT / "Change Requests").glob("*.md"))
CODE_FILES = lambda: sorted((PROJECT / "app" / "js").glob("*.js")) + sorted((PROJECT / "app" / "css").glob("*.css")) + \
    [PROJECT / "app" / "index.html", PROJECT / "razorcad.py"]
UI_FILES = ["app/js/ui.js", "app/js/drawingeditor.js", "app/js/main.js", "app/js/sketcher.js",
            "app/js/sheetmetal.js", "app/index.html"]
LABEL_RE = re.compile(r"""(?:label|title)\s*:\s*['"`]([^'"`]{2,80})['"`]""")
TOOL_RE = re.compile(r"""tool\('(\w+)',\s*'\w+',\s*'([^']+)'\)""")


def project_files():
    for p in sorted(PROJECT.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(PROJECT)
        if rel.parts[0] in SKIP_DIRS or any(part in SKIP_DIRS for part in rel.parts[:-1]):
            continue
        if p.suffix.lower() in SKIP_SUFFIX or p.name.endswith(".old.exe") or ".autosave." in p.name:
            continue
        yield rel.as_posix(), p


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ui_labels():
    out = {}
    for rel in UI_FILES:
        p = PROJECT / rel
        if p.exists():
            t = p.read_text(encoding="utf-8", errors="replace")
            labels = set(LABEL_RE.findall(t)) | {lab for _, lab in TOOL_RE.findall(t)}
            out[rel] = sorted(labels)
    return out


def snapshot():
    files = {}
    for rel, p in project_files():
        st = p.stat()
        files[rel] = {"sha": sha(p), "size": st.st_size,
                      "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")}
    ver = (PROJECT / "version.txt").read_text(encoding="utf-8").strip() if (PROJECT / "version.txt").exists() else ""
    return {"taken": datetime.now().isoformat(timespec="seconds"), "version": ver, "files": files, "ui": ui_labels()}


def text_diffs(files, copy_dir, limit):
    diffs = {}
    for p in files():
        if not p.exists():
            continue
        rel = p.relative_to(PROJECT).as_posix()
        old_p = copy_dir / rel
        new = p.read_text(encoding="utf-8", errors="replace").splitlines()
        old = old_p.read_text(encoding="utf-8", errors="replace").splitlines() if old_p.exists() else []
        if new != old:
            d = list(difflib.unified_diff(old, new, f"baseline/{rel}", rel, n=2, lineterm=""))
            diffs[rel] = "\n".join(d[:limit]) + (f"\n... (diff truncated: {len(d)} lines)" if len(d) > limit else "")
    return diffs


def report():
    now = snapshot()
    if not BASE.exists():
        return {"baseline": None, "note": "No baseline yet: run with --accept after the manual is current.",
                "version": now["version"], "changed": True}
    base = json.loads(BASE.read_text(encoding="utf-8"))
    bf, nf = base["files"], now["files"]
    added = sorted(set(nf) - set(bf))
    removed = sorted(set(bf) - set(nf))
    modified = sorted(k for k in set(nf) & set(bf) if nf[k]["sha"] != bf[k]["sha"])
    ui = {}
    for rel in set(now["ui"]) | set(base.get("ui", {})):
        a, b = set(base.get("ui", {}).get(rel, [])), set(now["ui"].get(rel, []))
        if a != b:
            ui[rel] = {"added_labels": sorted(b - a), "removed_labels": sorted(a - b)}
    r = {
        "baseline_taken": base["taken"],
        "checked": now["taken"],
        "version": {"baseline": base["version"], "now": now["version"]},
        "files_added": added,
        "files_removed": removed,
        "files_modified": [{"file": k, "modified": nf[k]["modified"], "size_before": bf[k]["size"], "size_now": nf[k]["size"]}
                           for k in modified],
        "ui_label_changes": ui,
        "doc_diffs": text_diffs(DOC_FILES, DOCS_COPY, 400),
        "code_diffs": text_diffs(CODE_FILES, CODE_COPY, 250),
    }
    r["changed"] = bool(added or removed or modified or base["version"] != now["version"])
    return r


def accept():
    TRACK.mkdir(exist_ok=True)
    BASE.write_text(json.dumps(snapshot(), indent=1), encoding="utf-8")
    for files, copy_dir in ((DOC_FILES, DOCS_COPY), (CODE_FILES, CODE_COPY)):
        if copy_dir.exists():
            shutil.rmtree(copy_dir)
        for p in files():
            if p.exists():
                dst = copy_dir / p.relative_to(PROJECT)
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, dst)
    print(f"Baseline recorded in {BASE}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if "--accept" in sys.argv:
        accept()
    else:
        TRACK.mkdir(exist_ok=True)
        r = report()
        REPORT.write_text(json.dumps(r, indent=1, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(r, indent=1, ensure_ascii=False))
