# Contributing to RazorCAD

Thanks for helping. RazorCAD is young and moves fast, so reports from real use are the most useful thing you can give.

## Reporting a bug

Open an issue with the **Bug report** form. What helps most:

- the version (Help ▸ About RazorCAD) and whether it's the desktop or browser version;
- the shortest steps that make it happen, and any message from the feature tree, word for word;
- a screenshot, and if you can, a small `.rcad` part that shows it (zip it: GitHub doesn't take `.rcad` files).
  Only share parts you're free to share.

If RazorCAD crashed, **Help ▸ Report a Problem** opens an issue with the crash report filled in. Your user name and
home folder are taken out of it, and nothing is sent until you press Submit on GitHub.

## Ideas and questions

Use the **Feature request** form for a specific feature, and
[Discussions](https://github.com/Labs9119/RazorCAD/discussions) for questions, open-ended ideas or to show what you've
made. Saying what the feature is *for* (the part or job) helps get the details right.

## Working on the code

RazorCAD is plain JavaScript (ES modules, no build step or framework) on an OpenCascade geometry kernel compiled to
WebAssembly, with a small Python shell (`razorcad.py`, pywebview) for the desktop app. The
[project layout](README.md#project-layout) in the README says where things are.

```
python serve.py 8800
```

serves the app at http://localhost:8800/ (any free port). Edit `app/`, reload the page. To build the desktop app,
see [Rebuilding the executable](README.md#rebuilding-the-executable).

### Tests

```
python -m pip install playwright
python tests/run_tests.py
```

runs the regression tests in headless Microsoft Edge (about half a minute): every test part rebuilt and compared
with `tests/expected.json`, drawings, and UI workflows. GitHub runs them on every push and pull request. See
[tests/README.md](tests/README.md) for the options. A change that alters a test part's geometry on purpose updates
the expected results with `--update`; say why in the pull request.

### Pull requests

- One change per pull request, with a test in `tests/suite.js` for new behaviour where it can be tested.
- Match the code around it: its naming, its comment style (comments say what and why, in plain words) and no new
  dependencies unless there's no other way.
- Add an entry to the top of `CHANGELOG.md` saying what changed, in words a user follows.
- User-facing changes belong in the manual too (`Manual/manual_source.md`).
- Don't include files you don't have the right to share (customer parts, drawings, fonts, other programs' files).

By contributing you agree that your work is released under the project's [GPL-3.0 license](LICENSE).
