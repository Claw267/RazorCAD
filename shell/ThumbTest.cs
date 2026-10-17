// Test for RazorCADThumbs.dll (not shipped): ThumbTest.exe FILE SIZE OUT.png
// Gives the file to the provider as an IStream (as Explorer does) and saves the bitmap it returns.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using RazorCAD.Shell;

class FileIStream : IStream
{
    readonly Stream s;
    public FileIStream(Stream s) { this.s = s; }
    public void Read(byte[] pv, int cb, IntPtr pcbRead) { int n = s.Read(pv, 0, cb); if (pcbRead != IntPtr.Zero) Marshal.WriteInt32(pcbRead, n); }
    public void Write(byte[] pv, int cb, IntPtr pcbWritten) { throw new NotSupportedException(); }
    public void Seek(long dlibMove, int dwOrigin, IntPtr plibNewPosition) { long p = s.Seek(dlibMove, (SeekOrigin)dwOrigin); if (plibNewPosition != IntPtr.Zero) Marshal.WriteInt64(plibNewPosition, p); }
    public void SetSize(long libNewSize) { throw new NotSupportedException(); }
    public void CopyTo(IStream pstm, long cb, IntPtr pcbRead, IntPtr pcbWritten) { throw new NotSupportedException(); }
    public void Commit(int grfCommitFlags) { }
    public void Revert() { }
    public void LockRegion(long libOffset, long cb, int dwLockType) { }
    public void UnlockRegion(long libOffset, long cb, int dwLockType) { }
    public void Stat(out System.Runtime.InteropServices.ComTypes.STATSTG pstatstg, int grfStatFlag) { pstatstg = new System.Runtime.InteropServices.ComTypes.STATSTG(); pstatstg.cbSize = s.Length; }
    public void Clone(out IStream ppstm) { throw new NotSupportedException(); }
}

static class Program
{
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

    static int Main(string[] args)
    {
        var p = new ThumbnailProvider();
        using (var f = File.OpenRead(args[0]))
            ((IInitializeWithStream)p).Initialize(new FileIStream(f), 0);
        IntPtr hbmp; uint alpha;
        try { ((IThumbnailProvider)p).GetThumbnail(uint.Parse(args[1]), out hbmp, out alpha); }
        catch (COMException e) { Console.WriteLine("no thumbnail (0x" + e.ErrorCode.ToString("X8") + ")"); return 2; }
        using (var img = Image.FromHbitmap(hbmp)) { img.Save(args[2], ImageFormat.Png); Console.WriteLine("thumbnail " + img.Width + "x" + img.Height + " alpha=" + alpha); }
        DeleteObject(hbmp);
        return 0;
    }
}
