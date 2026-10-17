// Test (not shipped): ShellThumb.exe FILE SIZE OUT.png — asks Windows' shell for a file's thumbnail the way
// Explorer does (IShellItemImageFactory, thumbnail only: through the thumbnail cache and the file type's
// registered thumbnail handler) and saves it.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

static class Program
{
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

    [STAThread]
    static int Main(string[] args)
    {
        IShellItemImageFactory f;
        SHCreateItemFromParsingName(System.IO.Path.GetFullPath(args[0]), IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
        int n = int.Parse(args[1]);
        IntPtr hbm;
        int hr = f.GetImage(new SIZE { cx = n, cy = n }, 0x8 /* SIIGBF_THUMBNAILONLY */, out hbm);
        if (hr != 0) { Console.WriteLine("no thumbnail: 0x" + hr.ToString("X8")); return 2; }
        using (var img = Image.FromHbitmap(hbm)) { img.Save(args[2], ImageFormat.Png); Console.WriteLine("thumbnail " + img.Width + "x" + img.Height); }
        DeleteObject(hbm);
        return 0;
    }
}
