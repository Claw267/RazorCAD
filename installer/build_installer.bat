@echo off
rem Builds RazorCAD-Setup-<version>.exe: the installer for testers, with RazorCAD.exe inside it.
rem Output: ..\..\RazorCAD Install\RazorCAD-Setup-<version>.exe  (next to the "CAD Software" folder)
rem Set the version in ..\version.txt before building a release: it goes into the file name, the
rem file's Properties (Details tab), the setup window and Windows' Installed apps list.
cd /d "%~dp0.."
set "ROOT=%CD%"
for %%I in ("%ROOT%\..\RazorCAD Install") do set "OUT=%%~fI"

echo Building RazorCAD.exe ...
call "%ROOT%\build.bat"
if not exist "%ROOT%\RazorCAD.exe" (
  echo RazorCAD.exe is missing - the application build failed.
  exit /b 1
)

echo Building the installer ...
if not exist "%OUT%" mkdir "%OUT%"
if not exist "%ROOT%\build\installer" mkdir "%ROOT%\build\installer"
rem the Explorer thumbnail handler (installed next to RazorCAD.exe)
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:library /optimize+ /out:"%ROOT%\build\installer\RazorCADThumbs.dll" /reference:System.Drawing.dll "%ROOT%\shell\RazorCADThumbs.cs"
if errorlevel 1 (
  echo Thumbnail handler build failed.
  exit /b 1
)
set "VER="
for /f "usebackq delims=" %%V in (`python "%ROOT%\installer\make_version_info.py" "%ROOT%\version.txt" "%ROOT%\build\installer\version_info.txt"`) do set "VER=%%V"
if not defined VER (
  echo Could not read the version from version.txt.
  exit /b 1
)
echo Version %VER%
rem the license, as LICENSE.txt so Windows opens it with a text editor
copy /y "%ROOT%\LICENSE" "%ROOT%\build\installer\LICENSE.txt" >nul
python -m PyInstaller --noconfirm --clean --onefile --windowed ^
  --name "RazorCAD-Setup-%VER%" --icon "%ROOT%\assets\razorcad.ico" ^
  --version-file "%ROOT%\build\installer\version_info.txt" ^
  --add-data "%ROOT%\RazorCAD.exe;payload" ^
  --add-data "%ROOT%\assets\razorcad.ico;payload" ^
  --add-data "%ROOT%\README.md;payload" ^
  --add-data "%ROOT%\version.txt;payload" ^
  --add-data "%ROOT%\build\installer\LICENSE.txt;payload" ^
  --add-data "%ROOT%\THIRD-PARTY-NOTICES.md;payload" ^
  --add-data "%ROOT%\build\installer\RazorCADThumbs.dll;payload" ^
  --distpath "%OUT%" --workpath "%ROOT%\build\installer" --specpath "%ROOT%\build\installer" ^
  "%ROOT%\installer\setup.py"
if errorlevel 1 (
  echo Installer build failed.
  exit /b 1
)
rem the read-me, with this version's file name in it
powershell -NoProfile -Command "$t = Get-Content -Raw -Encoding UTF8 '%ROOT%\installer\Read me first.txt'; $t = $t.Replace('{VERSION}', '%VER%'); [IO.File]::WriteAllText('%OUT%\Read me first.txt', $t, (New-Object Text.UTF8Encoding $true))"
rmdir /s /q "%ROOT%\build" 2>nul
echo.
echo Built "%OUT%\RazorCAD-Setup-%VER%.exe"
