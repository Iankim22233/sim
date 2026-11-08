// Minimal dependency-free TrueType (glyf) reader: font file -> SVG outline paths per character.
// Supports .ttf / first font of a .ttc, cmap format 4, simple + composite glyphs.
// Not supported: CFF-based .otf, .woff/.woff2 (convert to .ttf first).
import { readFileSync } from 'node:fs';

export function loadTTF(file) {
  const buf = readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u8 = o => dv.getUint8(o), i8 = o => dv.getInt8(o), u16 = o => dv.getUint16(o), i16 = o => dv.getInt16(o), u32 = o => dv.getUint32(o);
  const tag = o => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);

  let base = 0;
  if (tag(0) === 'ttcf') base = u32(12);
  const sig = tag(base);
  if (sig === 'OTTO') throw new Error('CFF-based .otf fonts are not supported; please use a TrueType .ttf');
  if (sig === 'wOFF' || sig === 'wOF2') throw new Error('.woff/.woff2 are not supported; please use a .ttf');
  const T = {};
  for (let i = 0, n = u16(base + 4); i < n; i++) {
    const o = base + 12 + 16 * i;
    T[tag(o)] = { off: u32(o + 8), len: u32(o + 12) };
  }
  for (const t of ['head', 'cmap', 'loca', 'glyf', 'hhea', 'hmtx', 'maxp']) if (!T[t]) throw new Error(`font has no '${t}' table (not a TrueType-outline font?)`);

  const upm = u16(T.head.off + 18);
  const locaLong = i16(T.head.off + 50) === 1;
  const numGlyphs = u16(T.maxp.off + 4);
  const numHM = u16(T.hhea.off + 34);
  const loc = g => (locaLong ? u32(T.loca.off + 4 * g) : u16(T.loca.off + 2 * g) * 2);
  const advance = g => u16(T.hmtx.off + 4 * Math.min(g, numHM - 1));

  // cmap: prefer (3,10)/(3,1)/(0,*) format 4
  let sub = -1;
  for (let i = 0, n = u16(T.cmap.off + 2); i < n; i++) {
    const pid = u16(T.cmap.off + 4 + 8 * i), eid = u16(T.cmap.off + 6 + 8 * i), off = T.cmap.off + u32(T.cmap.off + 8 + 8 * i);
    if (u16(off) === 4 && ((pid === 3 && eid === 1) || pid === 0) && (sub < 0 || pid === 3)) sub = off;
  }
  if (sub < 0) throw new Error('no usable Unicode cmap (format 4) in this font');
  const segN = u16(sub + 6) / 2, endO = sub + 14, startO = endO + 2 * segN + 2, deltaO = startO + 2 * segN, rangeO = deltaO + 2 * segN;
  const glyphFor = code => {
    for (let i = 0; i < segN; i++) {
      if (code > u16(endO + 2 * i)) continue;
      const start = u16(startO + 2 * i);
      if (code < start) return 0;
      const ro = u16(rangeO + 2 * i), delta = i16(deltaO + 2 * i);
      if (ro === 0) return (code + delta) & 0xffff;
      const g = u16(rangeO + 2 * i + ro + 2 * (code - start));
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };

  const f2 = o => i16(o) / 16384;
  function contours(g, depth = 0) { // -> [[{x,y,on}]]
    if (g >= numGlyphs || depth > 6) return [];
    const a = loc(g), b = loc(g + 1);
    if (a === b) return [];
    const off = T.glyf.off + a, nc = i16(off);
    if (nc >= 0) {
      let p = off + 10; const ends = [];
      for (let i = 0; i < nc; i++) ends.push(u16(p + 2 * i));
      p += 2 * nc; p += 2 + u16(p);
      const np = nc ? ends[nc - 1] + 1 : 0, flags = [];
      while (flags.length < np) { const f = u8(p++); flags.push(f); if (f & 8) { let r = u8(p++); while (r--) flags.push(f); } }
      const coord = (sBit, sameBit) => { let v = 0; return flags.map(f => {
        if (f & sBit) { const d = u8(p++); v += f & sameBit ? d : -d; } else if (!(f & sameBit)) { v += i16(p); p += 2; }
        return v; }); };
      const xs = coord(2, 16), ys = coord(4, 32), out = []; let s = 0;
      for (const e of ends) { out.push(xs.slice(s, e + 1).map((x, i) => ({ x, y: ys[s + i], on: !!(flags[s + i] & 1) }))); s = e + 1; }
      return out;
    }
    let p = off + 10, flags, out = [];
    do {
      flags = u16(p); const gi = u16(p + 2); p += 4;
      let a1, a2;
      if (flags & 1) { a1 = i16(p); a2 = i16(p + 2); p += 4; } else { a1 = i8(p); a2 = i8(p + 1); p += 2; }
      let A = 1, B = 0, C = 0, D = 1;
      if (flags & 8) { A = D = f2(p); p += 2; }
      else if (flags & 0x40) { A = f2(p); D = f2(p + 2); p += 4; }
      else if (flags & 0x80) { A = f2(p); B = f2(p + 2); C = f2(p + 4); D = f2(p + 6); p += 8; }
      const dx = flags & 2 ? a1 : 0, dy = flags & 2 ? a2 : 0;   // point-matching composites are rare; treated as no offset
      for (const c of contours(gi, depth + 1)) out.push(c.map(q => ({ x: A * q.x + C * q.y + dx, y: B * q.x + D * q.y + dy, on: q.on })));
    } while (flags & 0x20);
    return out;
  }

  const r = n => Math.round(n * 100) / 100;
  function contourPath(pts) {
    const n = pts.length; if (n < 2) return '';
    let start, list;
    if (pts[0].on) { start = pts[0]; list = pts.slice(1); }
    else if (pts[n - 1].on) { start = pts[n - 1]; list = pts.slice(0, n - 1); }
    else { start = { x: (pts[0].x + pts[n - 1].x) / 2, y: (pts[0].y + pts[n - 1].y) / 2 }; list = pts; }
    let d = `M${r(start.x)} ${r(start.y)}`, ctrl = null;
    for (const q of list) {
      if (q.on) { d += ctrl ? `Q${r(ctrl.x)} ${r(ctrl.y)} ${r(q.x)} ${r(q.y)}` : `L${r(q.x)} ${r(q.y)}`; ctrl = null; }
      else { if (ctrl) d += `Q${r(ctrl.x)} ${r(ctrl.y)} ${r((ctrl.x + q.x) / 2)} ${r((ctrl.y + q.y) / 2)}`; ctrl = q; }
    }
    if (ctrl) d += `Q${r(ctrl.x)} ${r(ctrl.y)} ${r(start.x)} ${r(start.y)}`;
    return d + 'Z';
  }

  // -> { d, minX, maxX, advance } in font units (y up), or null if the font has no glyph for this char
  function glyph(ch) {
    const g = glyphFor(ch.codePointAt(0));
    if (!g) return null;
    const cs = contours(g);
    let minX = Infinity, maxX = -Infinity;
    for (const c of cs) for (const q of c) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); }
    return { d: cs.map(contourPath).join(''), minX, maxX, advance: advance(g) };
  }
  return { upm, glyph };
}

// SVG for one terminal cell (w x h px) with the glyph baseline at `baseline`, scaled to `size` px.
export function glyphSvg(font, ch, { w = 8, h = 15, size = 13, baseline = 11.5, fill = '#eeedf0' } = {}) {
  const g = font.glyph(ch);
  if (!g || !g.d) return null;
  let s = size / font.upm;
  const bw = g.maxX - g.minX;
  if (bw * s > w - 0.4) s = (w - 0.4) / bw;            // shrink glyphs wider than a cell
  const tx = (w - bw * s) / 2 - g.minX * s;            // centre in the cell
  const f = n => Math.round(n * 1000) / 1000;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path transform="translate(${f(tx)} ${baseline}) scale(${f(s)} ${f(-s)})" fill="${fill}" d="${g.d}"/></svg>`;
}
