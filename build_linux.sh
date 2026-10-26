#!/bin/sh
# Builds RazorCAD for Linux: dist/RazorCAD (one file) and, when appimagetool is on the PATH, RazorCAD-x86_64.AppImage.
# Experimental: RazorCAD is made and tested on Windows; this build runs the same app in WebKitGTK (or Qt WebEngine).
# Requirements (one time, Debian / Ubuntu):
#   sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.1 libgirepository1.0-dev
#   python3 -m pip install "pywebview[gtk]" pyinstaller
set -e
cd "$(dirname "$0")"
VERSION="$(tr -d '\r\n' < version.txt)"
python3 -m PyInstaller --noconfirm --clean --onefile --windowed \
  --name RazorCAD \
  --add-data "app:app" \
  --add-data "version.txt:." \
  --distpath dist --workpath build/pyinstaller --specpath build \
  razorcad.py
echo "Built dist/RazorCAD ($VERSION)"

if command -v appimagetool >/dev/null 2>&1; then
  APPDIR=build/RazorCAD.AppDir
  rm -rf "$APPDIR"
  mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/512x512/apps" "$APPDIR/usr/share/mime/packages"
  cp dist/RazorCAD "$APPDIR/usr/bin/RazorCAD"
  cp installer/linux/razorcad.desktop "$APPDIR/razorcad.desktop"
  cp installer/linux/razorcad.desktop "$APPDIR/usr/share/applications/razorcad.desktop"
  cp installer/linux/razorcad-mime.xml "$APPDIR/usr/share/mime/packages/razorcad.xml"
  cp assets/razorcad-512.png "$APPDIR/razorcad.png"
  cp assets/razorcad-512.png "$APPDIR/usr/share/icons/hicolor/512x512/apps/razorcad.png"
  printf '#!/bin/sh\nexec "$(dirname "$(readlink -f "$0")")/usr/bin/RazorCAD" "$@"\n' > "$APPDIR/AppRun"
  chmod +x "$APPDIR/AppRun"
  ARCH=x86_64 appimagetool "$APPDIR" "RazorCAD-$VERSION-x86_64.AppImage"
  echo "Built RazorCAD-$VERSION-x86_64.AppImage"
else
  echo "(appimagetool not found: no AppImage made; dist/RazorCAD runs as it is)"
fi
