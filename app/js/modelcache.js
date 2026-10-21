// The model as last built, kept on disk so a part opens at once: a kernel rebuild result (meshes, sketches,
// planes, errors…) packed into one gzip-compressed binary, keyed by a hash of the part file's content.
// Opening a part whose content matches shows the stored model straight away while the kernel rebuilds it
// in the background (the desktop app keeps the files in %LOCALAPPDATA%\RazorCAD\modelcache).

// SHA-256 (hex) of a text, or null where the browser has no crypto.subtle.
export async function hashText(text) {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

const TYPED = { Float32Array, Float64Array, Uint32Array, Int32Array, Uint16Array, Int16Array, Uint8Array, Int8Array };

async function gzip(bytes, mode) {
  const s = new Blob([bytes]).stream().pipeThrough(mode === 'pack' ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// A rebuild result → base64 text (typed arrays as raw bytes after a JSON header).
export async function packResult(r) {
  const parts = [];
  let off = 0;
  const json = JSON.stringify(r, (k, v) => {
    if (ArrayBuffer.isView(v) && TYPED[v.constructor.name]) {
      const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      parts.push(b);
      const e = { __ta: v.constructor.name, o: off, n: b.byteLength };
      off += b.byteLength;
      return e;
    }
    return v;
  });
  const head = new TextEncoder().encode(json);
  const all = new Uint8Array(4 + head.length + off);
  new DataView(all.buffer).setUint32(0, head.length, true);
  all.set(head, 4);
  let p = 4 + head.length;
  for (const b of parts) { all.set(b, p); p += b.byteLength; }
  const z = await gzip(all, 'pack');
  const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(new Blob([z])); });
  return String(url).slice(String(url).indexOf(',') + 1);
}

// A long text → base64 of it gzipped, and back (null if it can't be read).
export async function packText(text) {
  const z = await gzip(new TextEncoder().encode(text), 'pack');
  const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(new Blob([z])); });
  return String(url).slice(String(url).indexOf(',') + 1);
}
export async function unpackText(b64) {
  try {
    const z = new Uint8Array(await (await fetch('data:application/octet-stream;base64,' + b64)).arrayBuffer());
    return new TextDecoder().decode(await gzip(z, 'unpack'));
  } catch {
    return null;
  }
}

// base64 text → the rebuild result (null if it can't be read).
export async function unpackResult(b64) {
  try {
    const z = new Uint8Array(await (await fetch('data:application/octet-stream;base64,' + b64)).arrayBuffer());
    const all = await gzip(z, 'unpack');
    const n = new DataView(all.buffer).getUint32(0, true);
    const base = 4 + n;
    return JSON.parse(new TextDecoder().decode(all.subarray(4, base)), (k, v) => {
      if (v && typeof v === 'object' && v.__ta && TYPED[v.__ta]) return new TYPED[v.__ta](all.buffer.slice(base + v.o, base + v.o + v.n));
      return v;
    });
  } catch {
    return null;
  }
}
