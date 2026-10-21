# Third-party notices

RazorCAD is licensed under the GNU General Public License v3.0 or later (see `LICENSE`).
It includes the third-party software listed below, each under its own license. The full license
texts are linked; each one also comes with that project's source.

## In the RazorCAD application (`app/vendor`)

| Component | Use | License |
|---|---|---|
| [Open CASCADE Technology](https://dev.opencascade.org/) | B-rep geometry kernel (compiled to WebAssembly in `replicad_single.wasm`, and with threads in `replicad_multi.wasm`) | [LGPL-2.1 with the Open CASCADE Exception 1.0](https://dev.opencascade.org/resources/licensing) |
| [replicad-opencascadejs](https://github.com/sgenoud/replicad/tree/main/packages/replicad-opencascadejs) / [opencascade.js](https://github.com/donalffons/opencascade.js) | The WebAssembly builds of Open CASCADE and their JavaScript bindings: single-thread (`replicad_single.js`, `.wasm`) and multi-threaded (`replicad_multi.js`, `.wasm`), both from replicad commit a0bc495 | [LGPL-2.1](https://github.com/donalffons/opencascade.js/blob/master/LICENSE) |
| [replicad](https://github.com/sgenoud/replicad) | CAD modelling library on top of Open CASCADE (`replicad.js`, `casting-*.js`) | [MIT](https://github.com/sgenoud/replicad/blob/main/LICENSE) |
| [opentype.js](https://github.com/opentypejs/opentype.js) | Font parsing for sketch text (bundled inside `replicad.js`) | [MIT](https://github.com/opentypejs/opentype.js/blob/master/LICENSE) |
| [three.js](https://threejs.org/) r169 | 3D display (`three.module.js`) | [MIT](https://github.com/mrdoob/three.js/blob/dev/LICENSE) |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | Fast picking and ray casting (`three-mesh-bvh.module.js`) | [MIT](https://github.com/gkjohnson/three-mesh-bvh/blob/master/LICENSE) |
| [DejaVu fonts](https://dejavu-fonts.github.io/) 2.x | DejaVu Sans, Sans Mono and Serif for sketch and drawing text (`app/fonts`, unmodified) | Bitstream Vera / Arev font licence, DejaVu changes public domain (`app/fonts/LICENSE_DEJAVU`) |

### Changes to the bundled libraries

RazorCAD changes three of these files to fix memory leaks in the kernel; see `KERNEL-MEMORY-FINDINGS.md`.
Each change is marked with a `RazorCAD:` comment or uses a `razorcad` name.

- `app/vendor/replicad/replicad_single.js` (opencascade.js bindings, LGPL-2.1): two hooks so RazorCAD can
  free kernel objects (`razorcadDtors`, `razorcadOnHandle`).
- `app/vendor/replicad/replicad_multi.js` (opencascade.js bindings, LGPL-2.1): the same two hooks, and the number
  of threads a kernel starts, and the processor count Open CASCADE sees, taken from `razorcadThreads`. The changes
  are made by `tools/patch_replicad_multi.py` from the published file (replicad commit a0bc495).
- `app/vendor/replicad/replicad.js` and `casting-rs4QjB74.js` (replicad, MIT): temporary objects are freed
  straight after use. `iterTopo` in `casting-rs4QjB74.js` groups the shapes it has met by hash code, so
  listing faces and edges doesn't compare each with all the others.

`replicad_single.wasm` and `replicad_multi.wasm` (Open CASCADE) are not modified. As the LGPL requires, you may replace these library
files with your own modified versions: they are plain files in this repository, and `build.bat` bundles them
into `RazorCAD.exe`. The Open CASCADE source is available from https://dev.opencascade.org/ and
https://github.com/Open-Cascade-SAS/OCCT.

## In RazorCAD.exe and the installer (bundled by PyInstaller)

| Component | Use | License |
|---|---|---|
| [Python](https://www.python.org/) 3.13 | Runtime of the desktop shell and installer | [PSF License 2.0](https://docs.python.org/3/license.html) |
| [pywebview](https://github.com/r0x0r/pywebview) 6.2 | Native window (Microsoft Edge WebView2) | [BSD-3-Clause](https://github.com/r0x0r/pywebview/blob/master/LICENSE) |
| [Python.NET (pythonnet)](https://github.com/pythonnet/pythonnet) and clr_loader | .NET access for the window layer | [MIT](https://github.com/pythonnet/pythonnet/blob/master/LICENSE) |
| [Bottle](https://bottlepy.org/) | pywebview's local web server | [MIT](https://github.com/bottlepy/bottle/blob/main/LICENSE) |
| proxy_tools | pywebview dependency | MIT |
| [cffi](https://github.com/python-cffi/cffi), [pycparser](https://github.com/eliben/pycparser) | pythonnet dependencies | MIT, BSD-3-Clause |
| [Tcl/Tk](https://www.tcl-lang.org/) | The installer window (tkinter) | [Tcl/Tk License (BSD-style)](https://www.tcl-lang.org/software/tcltk/license.html) |
| [PyInstaller](https://pyinstaller.org/) bootloader | Starts the bundled executables | [GPL-2.0 with the bootloader exception](https://github.com/pyinstaller/pyinstaller/blob/develop/COPYING.txt) (allows bundling programs under any license) |

## Not bundled

These are installed from Microsoft by the RazorCAD installer when they are missing, under Microsoft's own
license terms: the Microsoft Edge WebView2 Runtime and the .NET Framework. Fonts for sketch text are read
from the fonts Windows installs (`C:\Windows\Fonts`); none are bundled.
