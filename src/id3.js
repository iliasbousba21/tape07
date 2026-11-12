// Minimal ID3v2.2/2.3/2.4 reader for title + artist. Reads only the header region.
export async function readTags(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
    const ver = head[3];
    const flags = head[5];
    const size = syncsafe(head, 6);
    const buf = new Uint8Array(await file.slice(10, 10 + Math.min(size, 512 * 1024)).arrayBuffer());
    let p = 0;
    if (flags & 0x40 && ver >= 3) {
      const ext = ver === 4 ? syncsafe(buf, 0) : be32(buf, 0) + 4;
      p += ext;
    }
    const out = {};
    const idLen = ver === 2 ? 3 : 4;
    const hdrLen = ver === 2 ? 6 : 10;
    while (p + hdrLen < buf.length) {
      const id = String.fromCharCode(...buf.subarray(p, p + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break;
      let len;
      if (ver === 2) len = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
      else if (ver === 4) len = syncsafe(buf, p + 4);
      else len = be32(buf, p + 4);
      const body = buf.subarray(p + hdrLen, p + hdrLen + len);
      if (id === 'TIT2' || id === 'TT2') out.title = text(body);
      else if (id === 'TPE1' || id === 'TP1') out.artist = text(body);
      else if (id === 'TALB' || id === 'TAL') out.album = text(body);
      p += hdrLen + len;
      if (len <= 0) break;
    }
    return out;
  } catch {
    return {};
  }
}

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function text(body) {
  if (!body.length) return '';
  const enc = body[0];
  const data = body.subarray(1);
  let s;
  try {
    if (enc === 0) s = new TextDecoder('latin1').decode(data);
    else if (enc === 1) s = new TextDecoder('utf-16').decode(data);
    else if (enc === 2) s = new TextDecoder('utf-16be').decode(data);
    else s = new TextDecoder('utf-8').decode(data);
  } catch {
    s = '';
  }
  return s.replace(/\0+/g, ' / ').replace(/( \/ )+$/, '').trim();
}
