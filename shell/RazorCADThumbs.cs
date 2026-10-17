// RazorCAD thumbnail provider: Windows Explorer (and Open / Save dialogs) show a preview of .rcad,
// .rasm and .rdrw files. RazorCAD writes the preview into the file when it is saved, as the first
// member of the JSON:  { "thumbnail": "data:image/jpeg;base64,…", … }  so only the start of the file
// is read. Files without one show the normal icon.
//
// Built by build.bat with the .NET Framework compiler (csc, part of Windows):
//   csc /target:library /out:RazorCADThumbs.dll /reference:System.Drawing.dll RazorCADThumbs.cs
// Registered per user by RazorCAD (Help ▸ Open Files With RazorCAD ▸ Register) or by the installer:
// HKCU\Software\Classes\CLSID\{4F6B9D2E-7C1A-4E58-9B3D-2A61C0E5F7A1} (InprocServer32 = mscoree.dll,
// CodeBase = this DLL) and <ext>\ShellEx\{e357fccd-a995-4576-b01f-234630154e96} = that CLSID.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

[assembly: AssemblyTitle("RazorCAD thumbnail provider")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: ComVisible(false)]

namespace RazorCAD.Shell
{
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("b824b49d-22ac-4161-ac8a-9916e8fa3f7f")]
    public interface IInitializeWithStream
    {
        void Initialize(IStream pstream, uint grfMode);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("e357fccd-a995-4576-b01f-234630154e96")]
    public interface IThumbnailProvider
    {
        void GetThumbnail(uint cx, out IntPtr phbmp, out uint pdwAlpha);
    }

    [ComVisible(true), Guid("4F6B9D2E-7C1A-4E58-9B3D-2A61C0E5F7A1"), ClassInterface(ClassInterfaceType.None), ProgId("RazorCAD.ThumbnailProvider")]
    public class ThumbnailProvider : IInitializeWithStream, IThumbnailProvider
    {
        const int Chunk = 64 * 1024;
        const int MaxHead = 8 * 1024 * 1024; // (a preview is far smaller; never read more)
        byte[] image;

        public void Initialize(IStream pstream, uint grfMode)
        {
            image = null;
            try { image = Extract(pstream); }
            catch { image = null; }
            finally { try { Marshal.ReleaseComObject(pstream); } catch { } }
        }

        // The preview's bytes, from the start of the file (null if it has none).
        public static byte[] Extract(IStream stream)
        {
            var head = new MemoryStream();
            var buf = new byte[Chunk];
            IntPtr pRead = Marshal.AllocCoTaskMem(4);
            try
            {
                int dataStart = -1;
                while (head.Length < MaxHead)
                {
                    stream.Read(buf, buf.Length, pRead);
                    int n = Marshal.ReadInt32(pRead);
                    if (n <= 0) break;
                    head.Write(buf, 0, n);
                    string text = Encoding.ASCII.GetString(head.GetBuffer(), 0, (int)head.Length);
                    if (dataStart < 0)
                    {
                        int key = text.IndexOf("\"thumbnail\"", StringComparison.Ordinal);
                        // it is the first member: not near the start means there is none
                        if (key < 0) { if (head.Length >= 512) return null; continue; }
                        if (key > 200) return null;
                        int b64 = text.IndexOf("base64,", key, StringComparison.Ordinal);
                        if (b64 < 0) { if (head.Length > 4096) return null; continue; }
                        dataStart = b64 + 7;
                    }
                    int end = text.IndexOf('"', dataStart);
                    if (end >= 0) return Convert.FromBase64String(text.Substring(dataStart, end - dataStart));
                }
                return null;
            }
            finally { Marshal.FreeCoTaskMem(pRead); }
        }

        public void GetThumbnail(uint cx, out IntPtr phbmp, out uint pdwAlpha)
        {
            phbmp = IntPtr.Zero;
            pdwAlpha = 1; // WTSAT_RGB (opaque)
            if (image == null) throw new COMException("No preview", unchecked((int)0x80004005));
            using (var ms = new MemoryStream(image))
            using (var src = new Bitmap(ms))
            using (var bmp = Fit(src, (int)Math.Max(16, cx)))
                phbmp = bmp.GetHbitmap(Color.White);
        }

        // The preview scaled to fit a cx × cx square (aspect kept).
        public static Bitmap Fit(Image src, int cx)
        {
            double k = Math.Min((double)cx / src.Width, (double)cx / src.Height);
            int w = Math.Max(1, (int)Math.Round(src.Width * k)), h = Math.Max(1, (int)Math.Round(src.Height * k));
            var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.White);
                g.DrawImage(src, 0, 0, w, h);
            }
            return bmp;
        }
    }
}
