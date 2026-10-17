@echo off
rem Builds RazorCAD.exe (a single-file Windows executable) into this folder.
rem Requirements (one time):  python -m pip install pywebview pyinstaller pillow
cd /d "%~dp0"
if not exist assets\razorcad.ico python tools\make_icon.py
rem the Explorer thumbnail handler (shell\RazorCADThumbs.cs; the .NET Framework compiler comes with Windows)
if not exist build\shell mkdir build\shell
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:library /optimize+ /out:build\shell\RazorCADThumbs.dll /reference:System.Drawing.dll shell\RazorCADThumbs.cs
if errorlevel 1 (
  echo Thumbnail handler build failed.
  exit /b 1
)
python -m PyInstaller --noconfirm --clean --onefile --windowed ^
  --name RazorCAD --icon "%~dp0assets\razorcad.ico" ^
  --add-data "%~dp0app;app" ^
  --add-data "%~dp0build\shell\RazorCADThumbs.dll;shell" ^
  --distpath dist --workpath build\pyinstaller --specpath build ^
  razorcad.py
if errorlevel 1 (
  echo Build failed.
  exit /b 1
)
rem remove the copy set aside by an earlier build (only possible once that RazorCAD has closed)
if exist RazorCAD.old.exe del /q RazorCAD.old.exe 2>nul
copy /y dist\RazorCAD.exe RazorCAD.exe >nul 2>nul
if errorlevel 1 (
  rem RazorCAD is running: Windows can't overwrite a running program, but it can rename it.
  rem The running copy keeps working; the next launch starts the new build.
  if exist RazorCAD.old.exe (
    echo Could not replace RazorCAD.exe - close every RazorCAD window and run build.bat again.
    exit /b 1
  )
  ren RazorCAD.exe RazorCAD.old.exe
  copy /y dist\RazorCAD.exe RazorCAD.exe >nul
  if errorlevel 1 (
    echo Could not replace RazorCAD.exe - close RazorCAD and run build.bat again.
    exit /b 1
  )
  echo RazorCAD was running: the running copy was renamed to RazorCAD.old.exe.
  echo The new build starts the next time RazorCAD is opened.
)
rmdir /s /q dist build 2>nul
echo.
echo Built RazorCAD.exe
