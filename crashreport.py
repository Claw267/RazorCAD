"""Crash reports for RazorCAD.

Every report is a folder in %APPDATA%\\RazorCAD\\crashes\\<time>_<kind>\\ holding
  report.json      what happened: kind, message, stack trace, app state, system info
  session.log      the session's recent actions (newest last)
  part.rcad        the part that was open (when known), so the problem can be reproduced

Kinds of failure that are caught:
  python-exception     an uncaught exception in the desktop shell (sys/threading excepthook)
  native-crash         a hard crash of the process (faulthandler writes all threads' tracebacks)
  unexpected-shutdown  the process ended without closing normally (killed, power loss, ...);
                       found at the next launch from the session's lock file
  ui-error, kernel-... errors reported by the user interface / geometry kernel (report_ui)
"""
import ctypes
import datetime
import faulthandler
import json
import os
import platform
import re
import shutil
import sys
import threading
import traceback

MAX_REPORTS = 30
MAX_LOG_BYTES = 512 * 1024


def _now():
    return datetime.datetime.now()


def _pid_alive(pid):
    """True if a process with this id is still running (Windows; elsewhere assume not)."""
    if os.name != 'nt':
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return False
    try:
        code = ctypes.c_ulong()
        return bool(k32.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
    finally:
        k32.CloseHandle(h)


def app_version():
    # (version.txt: bundled next to the app's files, or in the source folder)
    try:
        with open(os.path.join(getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__))), 'version.txt'), encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return None


def system_info():
    exe = sys.executable
    try:
        build = datetime.datetime.fromtimestamp(os.path.getmtime(exe)).isoformat(timespec='seconds')
    except OSError:
        build = None
    return {
        'app': 'RazorCAD', 'version': app_version(), 'executable': exe, 'frozen': bool(getattr(sys, 'frozen', False)), 'exe_built': build,
        'python': sys.version.split()[0], 'platform': platform.platform(), 'machine': platform.machine(),
        'pid': os.getpid(),
    }


def scrub(text):
    """Personal details taken out of report text: the user's home folder and name (in paths and on their own)."""
    text = str(text or '')
    home = os.path.expanduser('~')
    user = os.path.basename(home.rstrip('\\/'))
    for h in {home, home.replace('\\', '/'), home.replace('\\', '\\\\')}:
        if h and len(h) > 3:
            text = re.sub(re.escape(h), '~', text, flags=re.I)
    text = re.sub(r'([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"\']+', lambda m: m.group(1) + '<user>', text, flags=re.I)
    if user and len(user) > 2 and user.lower() not in ('user', 'users', 'admin', 'public'):
        text = re.sub(r'\b' + re.escape(user) + r'\b', '<user>', text, flags=re.I)
    return text


def issue_text(folder, max_body=5500):
    """A crash report as a GitHub issue: (title, body), markdown, with personal details taken out (see scrub). The
    part the user was working on is not included."""
    report = {}
    try:
        with open(os.path.join(folder, 'report.json'), encoding='utf-8') as f:
            report = json.load(f)
    except (OSError, ValueError):
        pass
    kind = report.get('kind') or 'error'
    message = scrub(report.get('message') or '').strip()
    system = report.get('system') or {}
    title = f'Crash report: {kind}' + (f' - {message.splitlines()[0][:80]}' if message else '')
    lines = [
        '**What happened** (please add what you were doing when it happened):', '', '', '',
        '**Report**', '',
        f'- RazorCAD: {system.get("version") or app_version() or "?"}' + (' (installed build)' if system.get('frozen') else ''),
        f'- Windows: {scrub(system.get("platform") or platform.platform())}',
        f'- Kind: {kind}',
        f'- Time: {report.get("time") or "?"}',
    ]
    if message:
        lines += ['', '**Message**', '', '```', message[:1500], '```']
    extra = {k: v for k, v in report.items() if k not in ('kind', 'time', 'message', 'system')}
    if extra:
        lines += ['', '**Details**', '', '```', scrub(json.dumps(extra, indent=1, ensure_ascii=False))[:2500], '```']
    log = ''
    try:
        with open(os.path.join(folder, 'session.log'), encoding='utf-8', errors='replace') as f:
            log = scrub(''.join(f.readlines()[-40:]))
    except OSError:
        pass
    body = '\n'.join(lines)
    if log:
        room = max_body - len(body) - 60
        if room > 200:
            body += '\n\n**Last lines of the session log**\n\n```\n' + log[-room:] + '\n```'
    body += '\n\n(Sent from RazorCAD\'s crash report. The part being edited is not included: attach it if you can share it.)'
    return title[:120], body


class CrashReporter:
    def __init__(self, data_dir):
        self.data = data_dir
        self.dir = os.path.join(data_dir, 'crashes')
        os.makedirs(self.dir, exist_ok=True)
        pid = os.getpid()
        self.lock = os.path.join(data_dir, f'session-{pid}.lock')
        self.log = os.path.join(data_dir, f'session-{pid}.log')
        self.fatal = os.path.join(data_dir, f'fatal-{pid}.log')
        self._fatal_file = None
        self._log_lock = threading.Lock()
        self.part_provider = None  # () -> part JSON text (the last one the UI sent)

    # ------------------------------------------------------------ session
    def start(self):
        self._collect_previous_sessions()
        with open(self.lock, 'w', encoding='utf-8') as f:
            json.dump({'pid': os.getpid(), 'started': _now().isoformat(timespec='seconds')}, f)
        self._fatal_file = open(self.fatal, 'w', encoding='utf-8')
        faulthandler.enable(file=self._fatal_file, all_threads=True)
        sys.excepthook = self._excepthook
        threading.excepthook = lambda a: self._excepthook(a.exc_type, a.exc_value, a.exc_traceback, a.thread.name)
        info = system_info()
        self.event('RazorCAD %s started (%s)' % (info['version'] or '(version unknown)', info['platform']))

    def stop(self):
        """Normal shutdown: the session ended cleanly, so its files are not a crash."""
        self.event('RazorCAD closed normally')
        try:
            faulthandler.disable()
            if self._fatal_file:
                self._fatal_file.close()
        except Exception:
            pass
        for p in (self.fatal, self.lock):
            try:
                os.remove(p)
            except OSError:
                pass
        try:
            os.replace(self.log, os.path.join(self.data, 'last-session.log'))
        except OSError:
            pass

    def _collect_previous_sessions(self):
        """Sessions whose lock file is still there but whose process is gone ended abnormally."""
        for name in os.listdir(self.data):
            if not (name.startswith('session-') and name.endswith('.lock')):
                continue
            try:
                pid = int(name[len('session-'):-len('.lock')])
            except ValueError:
                continue
            if pid == os.getpid() or _pid_alive(pid):
                continue
            lock = os.path.join(self.data, name)
            log = os.path.join(self.data, f'session-{pid}.log')
            fatal = os.path.join(self.data, f'fatal-{pid}.log')
            started = None
            try:
                with open(lock, encoding='utf-8') as f:
                    started = json.load(f).get('started')
            except (OSError, ValueError):
                pass
            fatal_text = ''
            try:
                with open(fatal, encoding='utf-8', errors='replace') as f:
                    fatal_text = f.read().strip()
            except OSError:
                pass
            kind = 'native-crash' if fatal_text else 'unexpected-shutdown'
            message = ('RazorCAD crashed (fatal error in the process)' if fatal_text
                       else 'RazorCAD did not close normally (it was ended, crashed without a trace, or the computer shut down)')
            part = None
            last_part = os.path.join(self.data, f'session-{pid}.part.json')
            try:
                with open(last_part, encoding='utf-8') as f:
                    part = f.read()
            except OSError:
                pass
            self.write(kind, message, {'session_started': started, 'session_pid': pid, 'fatal_traceback': fatal_text or None},
                       part=part, log_path=log, system=False)
            for p in (lock, log, fatal, last_part):
                try:
                    os.remove(p)
                except OSError:
                    pass

    # ------------------------------------------------------------ events
    def event(self, text):
        line = '%s  %s\n' % (_now().isoformat(timespec='milliseconds'), str(text).replace('\n', ' ')[:500])
        with self._log_lock:
            try:
                if os.path.exists(self.log) and os.path.getsize(self.log) > MAX_LOG_BYTES:
                    with open(self.log, encoding='utf-8', errors='replace') as f:
                        keep = f.read()[-MAX_LOG_BYTES // 2:]
                    with open(self.log, 'w', encoding='utf-8') as f:
                        f.write(keep)
                with open(self.log, 'a', encoding='utf-8') as f:
                    f.write(line)
            except OSError:
                pass

    def remember_part(self, text):
        """The UI sends the open part now and then, so a crash report can include it."""
        try:
            with open(os.path.join(self.data, f'session-{os.getpid()}.part.json'), 'w', encoding='utf-8') as f:
                f.write(text or '')
        except OSError:
            pass

    # ------------------------------------------------------------ reports
    def _excepthook(self, etype, value, tb, thread=None):
        text = ''.join(traceback.format_exception(etype, value, tb))
        try:
            self.write('python-exception', f'{etype.__name__}: {value}', {'traceback': text, 'thread': thread})
        except Exception:
            pass
        sys.__excepthook__(etype, value, tb)

    def write(self, kind, message, details=None, part=None, log_path=None, system=True):
        stamp = _now().strftime('%Y-%m-%d_%H%M%S')
        folder = os.path.join(self.dir, f'{stamp}_{kind}')
        n = 2
        while os.path.exists(folder):
            folder = os.path.join(self.dir, f'{stamp}_{kind}_{n}')
            n += 1
        os.makedirs(folder)
        report = {'kind': kind, 'time': _now().isoformat(timespec='seconds'), 'message': message}
        report.update(details or {})
        report['system'] = system_info() if system else {**system_info(), 'note': 'system info of the session that found this report'}
        with open(os.path.join(folder, 'report.json'), 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        src_log = log_path or self.log
        if src_log and os.path.exists(src_log):
            try:
                shutil.copyfile(src_log, os.path.join(folder, 'session.log'))
            except OSError:
                pass
        if part is None and self.part_provider:
            try:
                part = self.part_provider()
            except Exception:
                part = None
        if part:
            with open(os.path.join(folder, 'part.rcad'), 'w', encoding='utf-8') as f:
                f.write(part)
        self._prune()
        return folder

    def _prune(self):
        items = sorted(d for d in os.listdir(self.dir) if os.path.isdir(os.path.join(self.dir, d)))
        for d in items[:-MAX_REPORTS]:
            shutil.rmtree(os.path.join(self.dir, d), ignore_errors=True)

    def recent(self):
        """Reports not yet shown to the user, newest first."""
        seen_file = os.path.join(self.dir, '.seen')
        try:
            with open(seen_file, encoding='utf-8') as f:
                seen = f.read().strip()
        except OSError:
            seen = ''
        out = []
        for d in sorted(os.listdir(self.dir), reverse=True):
            path = os.path.join(self.dir, d)
            if not os.path.isdir(path) or d <= seen:
                continue
            msg = kind = ''
            try:
                with open(os.path.join(path, 'report.json'), encoding='utf-8') as f:
                    r = json.load(f)
                msg, kind = r.get('message', ''), r.get('kind', '')
            except (OSError, ValueError):
                pass
            out.append({'name': d, 'kind': kind, 'message': msg})
        return out

    def all_reports(self, limit=12):
        """The reports kept (newest first): [{ name, kind, message, time }]."""
        out = []
        for d in sorted(os.listdir(self.dir), reverse=True):
            path = os.path.join(self.dir, d)
            if not os.path.isdir(path):
                continue
            r = {}
            try:
                with open(os.path.join(path, 'report.json'), encoding='utf-8') as f:
                    r = json.load(f)
            except (OSError, ValueError):
                pass
            out.append({'name': d, 'kind': r.get('kind', ''), 'message': scrub(r.get('message', ''))[:200], 'time': r.get('time', '')})
            if len(out) >= limit:
                break
        return out

    def mark_seen(self):
        items = sorted(d for d in os.listdir(self.dir) if os.path.isdir(os.path.join(self.dir, d)))
        if items:
            with open(os.path.join(self.dir, '.seen'), 'w', encoding='utf-8') as f:
                f.write(items[-1])
