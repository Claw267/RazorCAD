# RazorCAD regression tests

One command checks that the geometry kernel and the main workflows still give the same results after a change:

```
python tests/run_tests.py
```

It serves `app/` on a free local port, opens it in headless Microsoft Edge (Playwright, `pip install playwright`;
no browser download is needed, the installed Edge is used) and:

- **Parts:** rebuilds every `tests/parts/*.rcad` with the real kernel, in each configuration, and compares the
  feature errors and, per body, its kind, face and edge count, volume and area (and for sheet metal the flat
  pattern's size and bend count) with `tests/expected.json`. Numbers must agree to 1 part in a million.
- **UI:** does a few things the way a user does them, with pointer events on the view: sketch a rectangle,
  dimension it and extrude it; make a drawing of the part; build an assembly from two components; check the
  mouse buttons (Shift + right-drag pans, a plain right-drag changes nothing, middle-drag turns).

The exit code is 1 when anything fails, so it can be run before every build.

| Option | |
|---|---|
| `--only NAME ...` | just these parts or UI tests |
| `--update` | store the current results as the expected ones (after a deliberate change; check the numbers first) |
| `--make-parts` | rebuild `tests/parts/*.rcad` from `tests/make_parts.js` |
| `--headed` | show the browser window |

To cover a new feature, add a part to `make_parts.js`, run `python tests/run_tests.py --make-parts --only <name> --update`,
and check the recorded numbers by hand (for example a plate's volume) before committing them.
