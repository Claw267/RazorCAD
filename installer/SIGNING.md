# Code signing RazorCAD

Unsigned programs make Windows show "Windows protected your PC" (SmartScreen) and an "Unknown publisher"
prompt. A code-signing certificate puts your name on RazorCAD.exe, its thumbnail DLL and the setup, so
people can see who published them and that nobody changed them since.

The builds are ready for it: `build.bat` and `installer\build_installer.bat` run `tools\sign.py` on each file.
Until a certificate is set up they say "Not signed" and carry on, as before.

## 1. Get a certificate (you do this; it needs your identity checked)

Choose one:

- **A code-signing certificate from a certificate authority.** Since 2023 these come on a USB token or a
  cloud key (the private key can no longer be a plain file). An *OV* (organization / individual
  validation) certificate is enough to sign. An *EV* certificate costs more. SmartScreen gets used to a
  new certificate after enough downloads, so the warning fades over the first releases either way.
- **A cloud signing service** that signs through signtool (for example Azure Trusted Signing). It is paid
  monthly and you verify your identity with it.
- **Free signing for open-source projects** (for example the SignPath Foundation's programme), if
  RazorCAD is accepted. RazorCAD is GPL-licensed and its source is on GitHub.

Prices, requirements and who may apply change, so check the providers' current terms.

## 2. Install signtool

signtool comes with the Windows SDK: install it and tick only **"Signing Tools for Desktop Apps"**.
`tools\sign.py` finds it in `C:\Program Files (x86)\Windows Kits\10\bin\…\x64\`. If it is somewhere else,
set `RAZORCAD_SIGNTOOL` to its full path.

## 3. Tell the build which certificate to use

Use environment variables, or a `signing.local.json` next to `build.bat`. That file is ignored by git:
never put a password in it.

| Certificate | Setting |
|---|---|
| On a USB token, or installed in Windows | `RAZORCAD_SIGN_THUMBPRINT` = the certificate's SHA-1 thumbprint (certmgr.msc ▸ the certificate ▸ Details ▸ Thumbprint) |
| A .pfx file (older certificates, tests) | `RAZORCAD_SIGN_PFX` = path to the .pfx; its password in the environment variable `RAZORCAD_SIGN_PASSWORD` |
| A cloud signing service | `RAZORCAD_SIGN_DLIB` = its signtool library (.dll) and `RAZORCAD_SIGN_DMDF` = its metadata .json |
| Timestamp server (optional) | `RAZORCAD_SIGN_TIMESTAMP`, default `http://timestamp.digicert.com` |

Example `signing.local.json`:

```json
{ "thumbprint": "0123456789ABCDEF0123456789ABCDEF01234567" }
```

## 4. Check, then build

```
python tools\sign.py --check
python tools\sign.py --dry-run RazorCAD.exe
```

`--check` shows what is set up and whether signtool was found. `--dry-run` shows the signtool command
without running it (a password shows as ***). Then build as usual. Each file is signed with SHA-256 and
timestamped, so the signature stays valid after the certificate expires. It is then checked with
`signtool verify /pa`; a failed signing stops the build. With a token, keep it plugged in: it may ask for
its PIN once per file.

The installer's "Read me first.txt" follows along. A signed setup says how to check the publisher. An
unsigned one keeps the "More info ▸ Run anyway" steps.
