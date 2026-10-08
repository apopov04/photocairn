// Metadata inspector & scrubber for JPEG, PNG and WebP.
//
// Works on the original file bytes, not on decoded pixels: the image data is
// copied through untouched (no re-compression); only the chosen metadata is
// removed. EXIF is parsed tag by tag and rebuilt without the removed tags;
// other blocks (XMP, IPTC, ICC, comments, PNG text chunks...) are kept or
// dropped as a whole.
//
// parseMetadata(bytes) -> { format, items: [Item], ... }   Item = { id, group, name, value, defaultRemove }
// cleanMetadata(bytes, removeIds:Set) -> Uint8Array

/* --------------------------------- groups --------------------------------- */

export const GROUPS = {
  gps: { label: "Location (GPS)", private: true, hint: "Where the photo was taken, often accurate to a few meters." },
  device: { label: "Camera & device", private: true, hint: "Make, model, lens, software and serial numbers that can link photos to one device." },
  dates: { label: "Dates & times", private: true, hint: "When the photo was taken or edited." },
  people: { label: "Author, captions & copyright", private: true, hint: "Names, descriptions, keywords and IDs." },
  settings: { label: "Shooting settings", private: false, hint: "Exposure, ISO, focal length, flash… Mostly harmless." },
  makernote: { label: "Maker notes", private: true, hint: "Hidden camera-specific data. Can include serial numbers and more." },
  thumbnail: { label: "Embedded thumbnail", private: true, hint: "A small preview stored inside the file. It can show the photo before it was cropped or edited." },
  xmp: { label: "XMP data", private: true, hint: "Adobe/editing-app metadata: edit history, ratings, location, creator tool." },
  iptc: { label: "IPTC data", private: true, hint: "News/press metadata: captions, keywords, places, bylines." },
  comments: { label: "Comments & text", private: true, hint: "Free-text comments and text chunks." },
  extra: { label: "Extra data in the file", private: true, hint: "Embedded images or data after the picture (e.g. motion-photo video, depth maps)." },
  technical: { label: "Technical (display)", private: false, hint: "Orientation, resolution and color settings used to display the image correctly." },
  icc: { label: "Color profile", private: false, hint: "Keeps colors accurate. Removing it can shift colors slightly." },
};

/* ------------------------------- EXIF tags ------------------------------- */

// tag -> [name, group]
const IFD0_TAGS = {
  0x010e: ["Image description", "people"], 0x010f: ["Camera make", "device"], 0x0110: ["Camera model", "device"],
  0x0112: ["Orientation", "technical"], 0x011a: ["X resolution", "technical"], 0x011b: ["Y resolution", "technical"],
  0x0128: ["Resolution unit", "technical"], 0x0131: ["Software", "device"], 0x0132: ["Modified", "dates"],
  0x013b: ["Artist", "people"], 0x013c: ["Host computer", "device"], 0x0213: ["YCbCr positioning", "technical"],
  0x8298: ["Copyright", "people"], 0x9c9b: ["Title (Windows)", "people"], 0x9c9c: ["Comment (Windows)", "people"],
  0x9c9d: ["Author (Windows)", "people"], 0x9c9e: ["Keywords (Windows)", "people"], 0x9c9f: ["Subject (Windows)", "people"],
  0x4746: ["Rating", "people"], 0x4749: ["Rating percent", "people"], 0xc4a5: ["Print image matching", "technical"],
};
const EXIF_TAGS = {
  0x829a: ["Exposure time", "settings"], 0x829d: ["F-number", "settings"], 0x8822: ["Exposure program", "settings"],
  0x8827: ["ISO", "settings"], 0x8830: ["Sensitivity type", "settings"], 0x9000: ["EXIF version", "technical"],
  0x9003: ["Taken", "dates"], 0x9004: ["Digitized", "dates"], 0x9010: ["Time zone (modified)", "dates"],
  0x9011: ["Time zone (taken)", "dates"], 0x9012: ["Time zone (digitized)", "dates"], 0x9101: ["Components configuration", "technical"],
  0x9102: ["Compressed bits per pixel", "technical"], 0x9201: ["Shutter speed", "settings"], 0x9202: ["Aperture", "settings"],
  0x9203: ["Brightness", "settings"], 0x9204: ["Exposure bias", "settings"], 0x9205: ["Max aperture", "settings"],
  0x9206: ["Subject distance", "settings"], 0x9207: ["Metering mode", "settings"], 0x9208: ["Light source", "settings"],
  0x9209: ["Flash", "settings"], 0x920a: ["Focal length", "settings"], 0x9214: ["Subject area", "settings"],
  0x927c: ["Maker notes", "makernote"], 0x9286: ["User comment", "people"], 0x9290: ["Sub-seconds (modified)", "dates"],
  0x9291: ["Sub-seconds (taken)", "dates"], 0x9292: ["Sub-seconds (digitized)", "dates"], 0xa000: ["FlashPix version", "technical"],
  0xa001: ["Color space", "technical"], 0xa002: ["Pixel width", "technical"], 0xa003: ["Pixel height", "technical"],
  0xa20e: ["Focal plane X resolution", "settings"], 0xa20f: ["Focal plane Y resolution", "settings"], 0xa210: ["Focal plane resolution unit", "settings"],
  0xa217: ["Sensing method", "settings"], 0xa300: ["File source", "technical"], 0xa301: ["Scene type", "settings"],
  0xa401: ["Custom rendered", "settings"], 0xa402: ["Exposure mode", "settings"], 0xa403: ["White balance", "settings"],
  0xa404: ["Digital zoom", "settings"], 0xa405: ["Focal length (35mm)", "settings"], 0xa406: ["Scene capture type", "settings"],
  0xa407: ["Gain control", "settings"], 0xa408: ["Contrast", "settings"], 0xa409: ["Saturation", "settings"],
  0xa40a: ["Sharpness", "settings"], 0xa40c: ["Subject distance range", "settings"], 0xa420: ["Unique image ID", "people"],
  0xa430: ["Camera owner", "people"], 0xa431: ["Camera serial number", "device"], 0xa432: ["Lens specification", "device"],
  0xa433: ["Lens make", "device"], 0xa434: ["Lens model", "device"], 0xa435: ["Lens serial number", "device"],
  0xa460: ["Composite image", "settings"],
};
const GPS_TAGS = {
  0x0000: "GPS version", 0x0001: "Latitude ref", 0x0002: "Latitude", 0x0003: "Longitude ref", 0x0004: "Longitude",
  0x0005: "Altitude ref", 0x0006: "Altitude", 0x0007: "GPS time (UTC)", 0x0008: "Satellites", 0x0009: "GPS status",
  0x000a: "Measure mode", 0x000b: "Precision (DOP)", 0x000c: "Speed unit", 0x000d: "Speed", 0x000e: "Direction ref (movement)",
  0x000f: "Movement direction", 0x0010: "Image direction ref", 0x0011: "Image direction", 0x0012: "Map datum",
  0x0013: "Destination latitude ref", 0x0014: "Destination latitude", 0x0015: "Destination longitude ref", 0x0016: "Destination longitude",
  0x0017: "Destination bearing ref", 0x0018: "Destination bearing", 0x0019: "Destination distance ref", 0x001a: "Destination distance",
  0x001b: "Processing method", 0x001c: "Area information", 0x001d: "GPS date", 0x001e: "Differential", 0x001f: "Horizontal error",
};
const PTR_EXIF = 0x8769, PTR_GPS = 0x8825, PTR_INTEROP = 0xa005;
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/* ------------------------------ TIFF reading ------------------------------ */

function parseTiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = String.fromCharCode(bytes[0], bytes[1]);
  if (order !== "II" && order !== "MM") throw new Error("Bad TIFF header");
  const le = order === "II";
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const seen = new Set();
  const readIfd = (off) => {
    if (!off || off + 2 > bytes.length || seen.has(off)) return { entries: [], next: 0 };
    seen.add(off);
    const n = u16(off), entries = [];
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > bytes.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = (TYPE_SIZE[type] || 1) * count;
      const valOff = size <= 4 ? e + 8 : u32(e + 8);
      if (valOff + size > bytes.length) continue; // corrupt entry: drop it
      entries.push({ tag, type, count, raw: bytes.slice(valOff, valOff + size), ptr: u32(e + 8) });
    }
    const nextPos = off + 2 + n * 12;
    return { entries, next: nextPos + 4 <= bytes.length ? u32(nextPos) : 0 };
  };
  const ifd0 = readIfd(u32(4));
  const find = (ifd, tag) => ifd.entries.find((x) => x.tag === tag);
  const sub = (ifd, tag) => { const p = find(ifd, tag); return p ? readIfd(p.ptr) : { entries: [] }; };
  const exif = sub(ifd0, PTR_EXIF);
  const gps = sub(ifd0, PTR_GPS);
  const interop = sub(exif, PTR_INTEROP);
  const ifd1 = readIfd(ifd0.next);
  let thumb = null;
  const tOff = find(ifd1, 0x0201), tLen = find(ifd1, 0x0202);
  if (tOff && tLen) {
    const o = readNum(tOff, le), l = readNum(tLen, le);
    if (o + l <= bytes.length) thumb = bytes.slice(o, o + l);
  }
  const strip = (ifd, ...tags) => ifd.entries.filter((x) => !tags.includes(x.tag));
  return {
    le,
    ifd0: strip(ifd0, PTR_EXIF, PTR_GPS),
    exif: strip(exif, PTR_INTEROP),
    gps: gps.entries,
    interop: interop.entries,
    ifd1: strip(ifd1, 0x0201, 0x0202),
    thumb,
  };
}

function readNum(e, le) {
  const dv = new DataView(e.raw.buffer, e.raw.byteOffset, e.raw.byteLength);
  return e.type === 3 ? dv.getUint16(0, le) : dv.getUint32(0, le);
}

function formatValue(e, le) {
  const dv = new DataView(e.raw.buffer, e.raw.byteOffset, e.raw.byteLength);
  const n = Math.min(e.count, 16);
  const nums = (fn, size) => Array.from({ length: n }, (_, i) => fn(i * size));
  switch (e.type) {
    case 2: return new TextDecoder().decode(e.raw).replace(/\0+$/, "").trim();
    case 1: case 7: {
      if (e.tag >= 0x9c9b && e.tag <= 0x9c9f) return new TextDecoder("utf-16le").decode(e.raw).replace(/\0+$/, "");
      if (e.tag === 0x9286) return new TextDecoder().decode(e.raw.slice(8)).replace(/\0+/g, " ").trim() || "(empty)";
      if (e.count > 16) return `${e.count} bytes`;
      const ascii = /^[\x20-\x7e]+$/.test(new TextDecoder().decode(e.raw)) ? new TextDecoder().decode(e.raw) : null;
      return ascii || Array.from(e.raw).join(" ");
    }
    case 3: return nums((o) => dv.getUint16(o, le), 2).join(", ");
    case 4: return nums((o) => dv.getUint32(o, le), 4).join(", ");
    case 8: return nums((o) => dv.getInt16(o, le), 2).join(", ");
    case 9: return nums((o) => dv.getInt32(o, le), 4).join(", ");
    case 5: case 10: return nums((o) => {
      const a = e.type === 5 ? dv.getUint32(o, le) : dv.getInt32(o, le), b = e.type === 5 ? dv.getUint32(o + 4, le) : dv.getInt32(o + 4, le);
      return b ? +(a / b).toFixed(4) : 0;
    }, 8).join(", ");
    default: return `${e.raw.length} bytes`;
  }
}

function rationals(e, le) {
  const dv = new DataView(e.raw.buffer, e.raw.byteOffset, e.raw.byteLength);
  const out = [];
  for (let i = 0; i < e.count; i++) { const b = dv.getUint32(i * 8 + 4, le); out.push(b ? dv.getUint32(i * 8, le) / b : 0); }
  return out;
}

/** Decimal lat/lon from a parsed GPS IFD, or null. */
function gpsPosition(t) {
  const get = (tag) => t.gps.find((e) => e.tag === tag);
  const lat = get(2), lon = get(4), latRef = get(1), lonRef = get(3);
  if (!lat || !lon || lat.count < 3 || lon.count < 3) return null;
  const dms = (e) => { const [d, m, s] = rationals(e, t.le); return d + m / 60 + s / 3600; };
  let la = dms(lat), lo = dms(lon);
  if (latRef && String.fromCharCode(latRef.raw[0]) === "S") la = -la;
  if (lonRef && String.fromCharCode(lonRef.raw[0]) === "W") lo = -lo;
  if (!la && !lo) return null;
  return { lat: +la.toFixed(6), lon: +lo.toFixed(6) };
}

function exifItems(t, prefix) {
  const items = [];
  const add = (list, ifdName, names) => {
    for (const e of list) {
      const known = names[e.tag];
      const [name, group] = known ? (Array.isArray(known) ? known : [known, "gps"]) : [`Tag 0x${e.tag.toString(16).padStart(4, "0")}`, ifdName === "gps" ? "gps" : "settings"];
      let value = e.tag === 0x927c ? `${e.raw.length.toLocaleString()} bytes` : formatValue(e, t.le);
      if (ifdName === "gps" && (e.tag === 2 || e.tag === 4) && e.count >= 3) {
        const [d, m, s] = rationals(e, t.le); value = `${d}° ${m}' ${s.toFixed(2)}"`;
      }
      if (ifdName === "gps" && e.tag === 7 && e.count === 3) {
        const [hh, mm, ss] = rationals(e, t.le); value = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(Math.round(ss)).padStart(2, "0")}`;
      }
      items.push({ id: `${prefix}:${ifdName}:${e.tag}`, group, name, value: String(value).slice(0, 200), defaultRemove: GROUPS[group].private });
    }
  };
  add(t.ifd0, "ifd0", IFD0_TAGS);
  add(t.exif, "exif", EXIF_TAGS);
  add(t.gps, "gps", GPS_TAGS);
  if (t.interop.length) items.push({ id: `${prefix}:interop`, group: "technical", name: "Interoperability info", value: `${t.interop.length} tags`, defaultRemove: false });
  if (t.ifd1.length || t.thumb) items.push({ id: `${prefix}:thumb`, group: "thumbnail", name: "Thumbnail image", value: t.thumb ? `${t.thumb.length.toLocaleString()} bytes JPEG` : "present", defaultRemove: true, thumb: t.thumb });
  return items;
}

/* ------------------------------ TIFF writing ------------------------------ */

function buildTiff(t, remove, prefix) {
  const keep = (list, name) => list.filter((e) => !remove.has(`${prefix}:${name}:${e.tag}`));
  const ifd0 = keep(t.ifd0, "ifd0"), exif = keep(t.exif, "exif"), gps = keep(t.gps, "gps");
  const interop = remove.has(`${prefix}:interop`) ? [] : t.interop;
  const dropThumb = remove.has(`${prefix}:thumb`);
  const ifd1 = dropThumb ? [] : t.ifd1;
  const thumb = dropThumb ? null : t.thumb;
  if (!ifd0.length && !exif.length && !gps.length && !ifd1.length) return null;

  // Each block: entries (+ pointer placeholders) and its out-of-line data.
  const blocks = [];
  const mk = (name, entries) => { const b = { name, entries: entries.map((e) => ({ ...e })) }; blocks.push(b); return b; };
  const B0 = mk("ifd0", ifd0);
  const BE = exif.length || interop.length ? mk("exif", exif) : null;
  const BI = BE && interop.length ? mk("interop", interop) : null;
  const BG = gps.length ? mk("gps", gps) : null;
  const B1 = ifd1.length || thumb ? mk("ifd1", ifd1) : null;
  const ptr = (tag) => ({ tag, type: 4, count: 1, raw: new Uint8Array(4), pointer: true });
  if (BE) B0.entries.push({ ...ptr(PTR_EXIF), target: BE });
  if (BG) B0.entries.push({ ...ptr(PTR_GPS), target: BG });
  if (BI) BE.entries.push({ ...ptr(PTR_INTEROP), target: BI });
  if (B1 && thumb) {
    B1.entries.push({ tag: 0x0201, type: 4, count: 1, raw: new Uint8Array(4), thumbOffset: true });
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, thumb.length, t.le);
    B1.entries.push({ tag: 0x0202, type: 4, count: 1, raw: len });
  }
  for (const b of blocks) b.entries.sort((a, c) => a.tag - c.tag);

  // Layout.
  let off = 8;
  for (const b of blocks) {
    b.offset = off;
    off += 2 + b.entries.length * 12 + 4;
    for (const e of b.entries) if (e.raw.length > 4) { e.dataOffset = off; off += e.raw.length + (e.raw.length & 1); }
  }
  const thumbOffset = thumb ? off : 0;
  if (thumb) off += thumb.length;

  const out = new Uint8Array(off), dv = new DataView(out.buffer);
  out[0] = out[1] = t.le ? 0x49 : 0x4d;
  dv.setUint16(2, 42, t.le); dv.setUint32(4, 8, t.le);
  for (const b of blocks) {
    let p = b.offset;
    dv.setUint16(p, b.entries.length, t.le); p += 2;
    for (const e of b.entries) {
      dv.setUint16(p, e.tag, t.le); dv.setUint16(p + 2, e.type, t.le); dv.setUint32(p + 4, e.count, t.le);
      if (e.pointer) dv.setUint32(p + 8, e.target.offset, t.le);
      else if (e.thumbOffset) dv.setUint32(p + 8, thumbOffset, t.le);
      else if (e.raw.length > 4) { dv.setUint32(p + 8, e.dataOffset, t.le); out.set(e.raw, e.dataOffset); }
      else out.set(e.raw, p + 8);
      p += 12;
    }
    dv.setUint32(p, b === B0 && B1 ? B1.offset : 0, t.le);
  }
  if (thumb) out.set(thumb, thumbOffset);
  return out;
}

/* ---------------------------------- XMP ---------------------------------- */

function xmpSummary(text) {
  const pick = (re) => (text.match(re) || [])[1];
  const fields = [
    ["Creator tool", pick(/xmp:CreatorTool(?:="|>)([^"<]+)/)],
    ["Created", pick(/xmp:CreateDate(?:="|>)([^"<]+)/)],
    ["Modified", pick(/xmp:ModifyDate(?:="|>)([^"<]+)/)],
    ["Creator", pick(/<dc:creator>[\s\S]*?<rdf:li[^>]*>([^<]+)/)],
    ["Rights", pick(/<dc:rights>[\s\S]*?<rdf:li[^>]*>([^<]+)/)],
    ["GPS latitude", pick(/exif:GPSLatitude(?:="|>)([^"<]+)/)],
    ["GPS longitude", pick(/exif:GPSLongitude(?:="|>)([^"<]+)/)],
    ["Edit history", /stEvt:action|xmpMM:History/.test(text) ? "present" : null],
  ].filter(([, v]) => v);
  return fields.length ? fields.map(([k, v]) => `${k}: ${v}`).join(" · ") : `${text.length.toLocaleString()} characters`;
}

/* ---------------------------------- IPTC ---------------------------------- */

const IPTC_NAMES = { 5: "Title", 25: "Keywords", 55: "Date created", 60: "Time created", 80: "By-line", 85: "By-line title", 90: "City", 92: "Sub-location", 95: "State", 100: "Country code", 101: "Country", 105: "Headline", 110: "Credit", 115: "Source", 116: "Copyright", 120: "Caption" };
function iptcSummary(seg) {
  const out = [];
  for (let i = 0; i < seg.length - 5; i++) {
    if (seg[i] === 0x1c && seg[i + 1] === 2) {
      const rec = seg[i + 2], len = (seg[i + 3] << 8) | seg[i + 4];
      if (IPTC_NAMES[rec] && len < 2000) out.push(`${IPTC_NAMES[rec]}: ${new TextDecoder().decode(seg.slice(i + 5, i + 5 + len))}`);
      i += 4 + len;
    }
  }
  return out.length ? out.join(" · ").slice(0, 300) : `${seg.length.toLocaleString()} bytes`;
}

function iccDescription(icc) {
  try {
    const dv = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
    const n = dv.getUint32(128);
    for (let i = 0; i < n; i++) {
      const p = 132 + i * 12;
      if (String.fromCharCode(...icc.slice(p, p + 4)) !== "desc") continue;
      const off = dv.getUint32(p + 4), type = String.fromCharCode(...icc.slice(off, off + 4));
      if (type === "desc") { const len = dv.getUint32(off + 8); return new TextDecoder().decode(icc.slice(off + 12, off + 12 + len - 1)); }
      if (type === "mluc") { const len = dv.getUint32(off + 20), so = dv.getUint32(off + 24); return new TextDecoder("utf-16be").decode(icc.slice(off + so, off + so + len)); }
    }
  } catch { /* fall through */ }
  return `${icc.length.toLocaleString()} bytes`;
}

/* ---------------------------------- JPEG ---------------------------------- */

const ascii = (b, s, n) => String.fromCharCode(...b.slice(s, s + n));
const EXIF_HDR = "Exif\0\0", XMP_HDR = "http://ns.adobe.com/xap/1.0/\0", XMP_EXT = "http://ns.adobe.com/xmp/extension/\0";

function jpegSegments(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("Not a JPEG");
  const segs = [];
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) throw new Error("Corrupt JPEG");
    const marker = b[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xda) { segs.push({ marker, start: p, end: b.length, scan: true }); break; }
    if (marker >= 0xd0 && marker <= 0xd9) { segs.push({ marker, start: p, end: p + 2 }); p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    segs.push({ marker, start: p, end: p + 2 + len, data: b.subarray(p + 4, p + 2 + len) });
    p += 2 + len;
  }
  // Data after the end-of-image marker (trailers, motion-photo video...).
  const scan = segs.find((s) => s.scan);
  if (scan) {
    let eoi = -1;
    for (let i = b.length - 2; i > scan.start; i--) if (b[i] === 0xff && b[i + 1] === 0xd9) { eoi = i; break; }
    // Many files legitimately end at EOI; anything after is "extra".
    const firstEoi = findFirstEoi(b, scan.start);
    if (firstEoi > 0 && firstEoi + 2 < b.length) { scan.end = firstEoi + 2; scan.trailer = b.subarray(firstEoi + 2); }
    else if (eoi > 0) scan.end = eoi + 2;
  }
  return segs;
}

function findFirstEoi(b, from) {
  // Walk entropy-coded data: 0xFF followed by 0x00 or RSTn is data; FFD9 ends the image.
  for (let i = from + 2; i < b.length - 1; i++) {
    if (b[i] !== 0xff) continue;
    const m = b[i + 1];
    if (m === 0xd9) return i;
  }
  return -1;
}

function classifyJpeg(s) {
  const d = s.data;
  if (!d) return null;
  if (s.marker === 0xe1 && ascii(d, 0, 6) === EXIF_HDR) return "exif";
  if (s.marker === 0xe1 && (ascii(d, 0, XMP_HDR.length) === XMP_HDR || ascii(d, 0, XMP_EXT.length) === XMP_EXT)) return "xmp";
  if (s.marker === 0xe2 && ascii(d, 0, 12) === "ICC_PROFILE\0") return "icc";
  if (s.marker === 0xe2 && ascii(d, 0, 4) === "MPF\0") return "mpf";
  if (s.marker === 0xed && ascii(d, 0, 13) === "Photoshop 3.0") return "iptc";
  if (s.marker === 0xfe) return "comment";
  if (s.marker >= 0xe3 && s.marker <= 0xef && s.marker !== 0xee) return "app";
  return null;
}

function parseJpeg(b) {
  const segs = jpegSegments(b), items = [];
  let exifIdx = 0, gps = null;
  const icc = [];
  segs.forEach((s, i) => {
    const kind = classifyJpeg(s);
    if (kind === "exif") {
      try {
        const t = parseTiff(s.data.subarray(6));
        items.push(...exifItems(t, `jexif${exifIdx}`));
        gps = gps || gpsPosition(t);
        s.tiff = t; s.prefix = `jexif${exifIdx++}`;
      } catch { items.push({ id: `seg:${i}`, group: "extra", name: "Unreadable EXIF block", value: `${s.data.length} bytes`, defaultRemove: true }); }
    } else if (kind === "xmp") items.push({ id: `seg:${i}`, group: "xmp", name: "XMP packet", value: xmpSummary(new TextDecoder().decode(s.data)), defaultRemove: true });
    else if (kind === "iptc") items.push({ id: `seg:${i}`, group: "iptc", name: "IPTC / Photoshop info", value: iptcSummary(s.data), defaultRemove: true });
    else if (kind === "comment") items.push({ id: `seg:${i}`, group: "comments", name: "JPEG comment", value: new TextDecoder().decode(s.data).slice(0, 200), defaultRemove: true });
    else if (kind === "icc") icc.push(i);
    else if (kind === "mpf") items.push({ id: `seg:${i}`, group: "extra", name: "Multi-picture index", value: "Links to extra embedded images", defaultRemove: true });
    else if (kind === "app") items.push({ id: `seg:${i}`, group: "extra", name: `APP${s.marker - 0xe0} block`, value: `${ascii(s.data, 0, 20).replace(/[^\x20-\x7e]/g, "") || "binary"} · ${s.data.length.toLocaleString()} bytes`, defaultRemove: true });
    if (s.trailer) items.push({ id: "trailer", group: "extra", name: "Data after the image", value: `${s.trailer.length.toLocaleString()} bytes (e.g. motion photo, depth map)`, defaultRemove: true });
  });
  if (icc.length) {
    const bytes = concat(icc.map((i) => segs[i].data.subarray(14)));
    items.push({ id: "icc", group: "icc", name: "ICC color profile", value: iccDescription(bytes), defaultRemove: false });
  }
  return { format: "JPEG", mime: "image/jpeg", items, gps, segs, icc };
}

function cleanJpeg(b, remove) {
  const { segs } = parseJpeg(b);
  const parts = [b.subarray(0, 2)];
  segs.forEach((s, i) => {
    const kind = classifyJpeg(s);
    if (s.scan) { parts.push(b.subarray(s.start, s.end)); if (s.trailer && !remove.has("trailer")) parts.push(s.trailer); return; }
    if (remove.has(`seg:${i}`)) return;
    if (kind === "icc" && remove.has("icc")) return;
    if (kind === "exif" && s.tiff) {
      const tiff = buildTiff(s.tiff, remove, s.prefix);
      if (!tiff) return;
      const body = concat([new TextEncoder().encode(EXIF_HDR), tiff]);
      if (body.length + 2 > 0xffff) { parts.push(b.subarray(s.start, s.end)); return; } // can't fit; keep original
      parts.push(new Uint8Array([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
      return;
    }
    parts.push(b.subarray(s.start, s.end));
  });
  return concat(parts);
}

/* ---------------------------------- PNG ---------------------------------- */

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunks(b) {
  if (!PNG_SIG.every((v, i) => b[i] === v)) throw new Error("Not a PNG");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), chunks = [];
  let p = 8;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p), type = ascii(b, p + 4, 4);
    chunks.push({ type, start: p, end: p + 12 + len, data: b.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === "IEND") break;
  }
  return chunks;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function parsePng(b) {
  const chunks = pngChunks(b), items = [];
  let gps = null;
  chunks.forEach((c, i) => {
    const t = c.type;
    if (t === "eXIf") {
      try { const tiff = parseTiff(c.data); c.tiff = tiff; c.prefix = `pexif${i}`; items.push(...exifItems(tiff, c.prefix)); gps = gps || gpsPosition(tiff); } catch { items.push({ id: `chunk:${i}`, group: "extra", name: "Unreadable EXIF", value: "", defaultRemove: true }); }
    } else if (t === "tEXt" || t === "iTXt" || t === "zTXt") {
      const z = c.data.indexOf(0), key = ascii(c.data, 0, z);
      let value = "(compressed)";
      if (t === "tEXt") value = new TextDecoder("latin1").decode(c.data.subarray(z + 1));
      if (t === "iTXt" && c.data[z + 1] === 0) { let q = z + 3; q = c.data.indexOf(0, q) + 1; q = c.data.indexOf(0, q) + 1; value = new TextDecoder().decode(c.data.subarray(q)); }
      const isXmp = key === "XML:com.adobe.xmp";
      items.push({ id: `chunk:${i}`, group: isXmp ? "xmp" : /author|copyright|comment|description|title/i.test(key) ? "people" : /creation|date|time/i.test(key) ? "dates" : /software/i.test(key) ? "device" : "comments", name: isXmp ? "XMP packet" : key, value: (isXmp ? xmpSummary(value) : value).slice(0, 200), defaultRemove: true });
    } else if (t === "tIME") {
      const dv = new DataView(c.data.buffer, c.data.byteOffset);
      items.push({ id: `chunk:${i}`, group: "dates", name: "Last modified", value: `${dv.getUint16(0)}-${String(c.data[2]).padStart(2, "0")}-${String(c.data[3]).padStart(2, "0")} ${c.data[4]}:${String(c.data[5]).padStart(2, "0")}`, defaultRemove: true });
    } else if (t === "iCCP") items.push({ id: `chunk:${i}`, group: "icc", name: "ICC color profile", value: ascii(c.data, 0, c.data.indexOf(0)), defaultRemove: false });
    else if (t === "pHYs") items.push({ id: `chunk:${i}`, group: "technical", name: "Pixel density", value: `${new DataView(c.data.buffer, c.data.byteOffset).getUint32(0)} px/unit`, defaultRemove: false });
    else if (/^[a-z]/.test(t) && !["tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "bKGD", "hIST", "sPLT", "acTL", "fcTL", "fdAT"].includes(t)) {
      items.push({ id: `chunk:${i}`, group: "extra", name: `"${t}" chunk`, value: `${c.data.length.toLocaleString()} bytes`, defaultRemove: true });
    }
  });
  return { format: "PNG", mime: "image/png", items, gps };
}

function cleanPng(b, remove) {
  const chunks = pngChunks(b), parts = [new Uint8Array(PNG_SIG)];
  chunks.forEach((c, i) => {
    if (remove.has(`chunk:${i}`)) return;
    if (c.type === "eXIf") {
      try {
        const tiff = buildTiff(parseTiff(c.data), remove, `pexif${i}`);
        if (tiff) parts.push(pngChunk("eXIf", tiff));
      } catch { /* drop unreadable */ }
      return;
    }
    parts.push(b.subarray(c.start, c.end));
  });
  return concat(parts);
}

/* ---------------------------------- WebP ---------------------------------- */

function webpChunks(b) {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") throw new Error("Not a WebP");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), chunks = [];
  let p = 12;
  while (p + 8 <= b.length) {
    const type = ascii(b, p, 4), len = dv.getUint32(p + 4, true);
    chunks.push({ type, start: p, end: Math.min(b.length, p + 8 + len + (len & 1)), data: b.subarray(p + 8, p + 8 + len) });
    p += 8 + len + (len & 1);
  }
  return chunks;
}

function parseWebp(b) {
  const chunks = webpChunks(b), items = [];
  let gps = null;
  chunks.forEach((c, i) => {
    if (c.type === "EXIF") {
      const d = ascii(c.data, 0, 6) === EXIF_HDR ? c.data.subarray(6) : c.data;
      try { const tiff = parseTiff(d); items.push(...exifItems(tiff, `wexif${i}`)); gps = gps || gpsPosition(tiff); } catch { items.push({ id: `chunk:${i}`, group: "extra", name: "Unreadable EXIF", value: "", defaultRemove: true }); }
    } else if (c.type === "XMP ") items.push({ id: `chunk:${i}`, group: "xmp", name: "XMP packet", value: xmpSummary(new TextDecoder().decode(c.data)), defaultRemove: true });
    else if (c.type === "ICCP") items.push({ id: `chunk:${i}`, group: "icc", name: "ICC color profile", value: iccDescription(c.data), defaultRemove: false });
  });
  return { format: "WebP", mime: "image/webp", items, gps };
}

function cleanWebp(b, remove) {
  const chunks = webpChunks(b), parts = [];
  let flags = null, vp8xIdx = -1;
  chunks.forEach((c, i) => {
    if (remove.has(`chunk:${i}`)) return;
    if (c.type === "EXIF") {
      const hasHdr = ascii(c.data, 0, 6) === EXIF_HDR;
      let tiff = null;
      try { tiff = buildTiff(parseTiff(hasHdr ? c.data.subarray(6) : c.data), remove, `wexif${i}`); } catch { /* drop */ }
      if (!tiff) return;
      const body = hasHdr ? concat([new TextEncoder().encode(EXIF_HDR), tiff]) : tiff;
      parts.push(riffChunk("EXIF", body));
      return;
    }
    if (c.type === "VP8X") { vp8xIdx = parts.length; flags = c; }
    parts.push(b.subarray(c.start, c.end));
  });
  // Keep the VP8X feature flags in sync with what's left.
  if (vp8xIdx >= 0) {
    const kept = (type) => chunks.some((c, i) => c.type === type && !remove.has(`chunk:${i}`) && (type !== "EXIF" || hasExifLeft(c, i, remove)));
    const v = new Uint8Array(parts[vp8xIdx]);
    v[8] = (v[8] & ~(0x20 | 0x08 | 0x04)) | (kept("ICCP") ? 0x20 : 0) | (kept("EXIF") ? 0x08 : 0) | (kept("XMP ") ? 0x04 : 0);
    parts[vp8xIdx] = v;
  }
  const body = concat(parts);
  const head = new Uint8Array(12);
  head.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set(new TextEncoder().encode("WEBP"), 8);
  return concat([head, body]);
}

function hasExifLeft(c, i, remove) {
  try { const d = ascii(c.data, 0, 6) === EXIF_HDR ? c.data.subarray(6) : c.data; return !!buildTiff(parseTiff(d), remove, `wexif${i}`); } catch { return false; }
}

function riffChunk(type, data) {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  out.set(new TextEncoder().encode(type), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

/* --------------------------------- public --------------------------------- */

function concat(arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

export function detectFormat(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (PNG_SIG.every((v, i) => b[i] === v)) return "png";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  return null;
}

export function parseMetadata(bytes) {
  const f = detectFormat(bytes);
  if (f === "jpeg") return parseJpeg(bytes);
  if (f === "png") return parsePng(bytes);
  if (f === "webp") return parseWebp(bytes);
  throw new Error("Only JPEG, PNG and WebP files are supported.");
}

export function cleanMetadata(bytes, remove) {
  const f = detectFormat(bytes);
  if (f === "jpeg") return cleanJpeg(bytes, remove);
  if (f === "png") return cleanPng(bytes, remove);
  if (f === "webp") return cleanWebp(bytes, remove);
  throw new Error("Unsupported format.");
}

// Exposed for tests.
export const _internal = { parseTiff, buildTiff, crc32, pngChunk, riffChunk, concat };
