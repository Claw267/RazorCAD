"""Writes the Windows version information for RazorCAD-Setup.exe (File ▸ Properties ▸ Details) from
version.txt, and prints the version (build_installer.bat reads it for the file name).

    python make_version_info.py <version.txt> <output file>
"""
import re
import sys

src, out = sys.argv[1], sys.argv[2]
with open(src, encoding='utf-8') as f:
    ver = f.read().strip()
# Windows wants four numbers: 0.10.0-beta -> 0, 10, 0, 0
nums = [int(n) for n in re.findall(r'\d+', ver.split('-')[0])][:4]
nums += [0] * (4 - len(nums))
t = tuple(nums)
info = f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers={t}, prodvers={t}, mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'RazorCAD'),
      StringStruct('FileDescription', 'RazorCAD {ver} Setup'),
      StringStruct('FileVersion', '{ver}'),
      StringStruct('InternalName', 'RazorCAD-Setup'),
      StringStruct('OriginalFilename', 'RazorCAD-Setup-{ver}.exe'),
      StringStruct('ProductName', 'RazorCAD'),
      StringStruct('ProductVersion', '{ver}')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"""
with open(out, 'w', encoding='utf-8') as f:
    f.write(info)
print(ver)
