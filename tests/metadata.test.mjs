import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMetadata, cleanMetadata, _internal as M } from "../js/metadata.js";

const enc = (s) => new TextEncoder().encode(s);
const u32 = (n, le) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, le); return b; };
const rat = (vals, le) => M.concat(vals.flatMap(([a, b]) => [u32(a, le), u32(b, le)]));
const ascii = (s) => ({ type: 2, count: s.length + 1, raw: enc(s + "\0") });

/** A small EXIF TIFF with camera, date, GPS and a thumbnail. */
function makeTiff(le = true) {
  return M.buildTiff({
    le,
    ifd0: [{ tag: 0x010f, ...ascii("Acme") }, { tag: 0x0110, ...ascii("Snapper 3000") }, { tag: 0x0112, type: 3, count: 1, raw: new Uint8Array(le ? [6, 0, 0, 0] : [0, 6, 0, 0]) }],
    exif: [{ tag: 0x9003, ...ascii("2026:10:08 12:00:00") }, { tag: 0xa431, ...ascii("SN-123456") }],
    gps: [
      { tag: 1, ...ascii("N") }, { tag: 2, type: 5, count: 3, raw: rat([[41, 1], [23, 1], [2400, 100]], le) },
      { tag: 3, ...ascii("E") }, { tag: 4, type: 5, count: 3, raw: rat([[2, 1], [10, 1], [3000, 100]], le) },
    ],
    interop: [], ifd1: [{ tag: 0x0103, type: 3, count: 1, raw: new Uint8Array(le ? [6, 0, 0, 0] : [0, 6, 0, 0]) }],
    thumb: new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]),
  }, new Set(), "x");
}

function seg(marker, body) {
  const len = body.length + 2;
  return M.concat([new Uint8Array([0xff, marker, len >> 8, len & 255]), body]);
}

const SCAN = new Uint8Array([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]);
function makeJpeg({ le = true, trailer = false } = {}) {
  return M.concat([
    new Uint8Array([0xff, 0xd8]),
    seg(0xe0, enc("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    seg(0xe1, M.concat([enc("Exif\0\0"), makeTiff(le)])),
    seg(0xe1, enc('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description xmp:CreatorTool="Lightroom"/></x:xmpmeta>')),
    seg(0xfe, enc("secret comment")),
    SCAN,
    trailer ? enc("MOTIONPHOTO-VIDEO-BYTES") : new Uint8Array(),
  ]);
}

const ids = (meta, group) => meta.items.filter((i) => i.group === group).map((i) => i.id);

for (const le of [true, false]) {
  test(`JPEG EXIF parse (${le ? "little" : "big"} endian): GPS, device, dates, thumbnail`, () => {
    const m = parseMetadata(makeJpeg({ le }));
    assert.equal(m.format, "JPEG");
    assert.deepEqual(m.gps, { lat: 41.39, lon: 2.175 });
    const byName = Object.fromEntries(m.items.map((i) => [i.name, i.value]));
    assert.equal(byName["Camera make"], "Acme");
    assert.equal(byName["Camera model"], "Snapper 3000");
    assert.equal(byName["Camera serial number"], "SN-123456");
    assert.equal(byName["Taken"], "2026:10:08 12:00:00");
    assert.equal(byName["Orientation"], "6");
    assert.ok(ids(m, "thumbnail").length === 1);
    assert.ok(ids(m, "xmp").length === 1 && /Lightroom/.test(m.items.find((i) => i.group === "xmp").value));
    assert.ok(ids(m, "comments").length === 1);
  });
}

test("removing GPS keeps everything else and leaves image data byte-identical", () => {
  const src = makeJpeg();
  const m = parseMetadata(src);
  const out = cleanMetadata(src, new Set(ids(m, "gps")));
  const m2 = parseMetadata(out);
  assert.equal(m2.gps, null);
  assert.equal(ids(m2, "gps").length, 0);
  assert.equal(m2.items.find((i) => i.name === "Camera model").value, "Snapper 3000");
  assert.equal(ids(m2, "thumbnail").length, 1);
  // Scan data untouched.
  assert.deepEqual([...out.subarray(out.length - SCAN.length)], [...SCAN]);
});

test("remove all private data: only technical tags remain", () => {
  const src = makeJpeg({ trailer: true });
  const m = parseMetadata(src);
  assert.ok(m.items.some((i) => i.id === "trailer"));
  const remove = new Set(m.items.filter((i) => i.defaultRemove).map((i) => i.id));
  const out = cleanMetadata(src, remove);
  const m2 = parseMetadata(out);
  assert.deepEqual([...new Set(m2.items.map((i) => i.group))], ["technical"]);
  assert.ok(!new TextDecoder().decode(out).includes("secret comment"));
  assert.ok(!new TextDecoder().decode(out).includes("MOTIONPHOTO"));
  assert.ok(!new TextDecoder().decode(out).includes("SN-123456"));
  assert.ok(out.length < src.length);
});

test("removing every EXIF tag drops the whole EXIF block", () => {
  const src = makeJpeg();
  const m = parseMetadata(src);
  const out = cleanMetadata(src, new Set(m.items.filter((i) => i.id.startsWith("jexif")).map((i) => i.id)));
  assert.ok(!new TextDecoder("latin1").decode(out).includes("Exif\0\0"));
});

test("PNG: text chunks and eXIf are listed and removed, CRCs valid", () => {
  const ihdr = M.pngChunk("IHDR", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const png = M.concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ihdr,
    M.pngChunk("tEXt", enc("Author\0Jane Doe")), M.pngChunk("eXIf", makeTiff()),
    M.pngChunk("IDAT", new Uint8Array([1, 2, 3])), M.pngChunk("IEND", new Uint8Array()),
  ]);
  const m = parseMetadata(png);
  assert.equal(m.format, "PNG");
  assert.ok(m.items.some((i) => i.name === "Author" && i.value === "Jane Doe"));
  assert.ok(m.gps);
  const out = cleanMetadata(png, new Set(m.items.filter((i) => i.defaultRemove).map((i) => i.id)));
  const m2 = parseMetadata(out);
  assert.ok(!m2.items.some((i) => i.name === "Author"));
  assert.equal(m2.gps, null);
  // Every chunk CRC must check out.
  const dv = new DataView(out.buffer, out.byteOffset);
  for (let p = 8; p < out.length;) {
    const len = dv.getUint32(p);
    assert.equal(dv.getUint32(p + 8 + len), M.crc32(out.subarray(p + 4, p + 8 + len)));
    p += 12 + len;
  }
});

test("WebP: EXIF/XMP removed and VP8X flags + RIFF size updated", () => {
  const vp8x = M.riffChunk("VP8X", new Uint8Array([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const body = M.concat([enc("WEBP"), vp8x, M.riffChunk("VP8L", new Uint8Array([0x2f, 0, 0, 0, 0])), M.riffChunk("EXIF", makeTiff()), M.riffChunk("XMP ", enc("<x/>"))]);
  const riff = M.concat([enc("RIFF"), u32(body.length, true), body]);
  const m = parseMetadata(riff);
  assert.equal(m.format, "WebP");
  assert.ok(m.gps);
  const out = cleanMetadata(riff, new Set(m.items.map((i) => i.id)));
  assert.equal(new DataView(out.buffer).getUint32(4, true), out.length - 8);
  assert.equal(out[20] & 0x0c, 0); // EXIF + XMP flags cleared
  assert.equal(parseMetadata(out).items.length, 0);
});

test("unsupported formats throw a friendly error", () => {
  assert.throws(() => parseMetadata(enc("GIF89a....")), /JPEG, PNG and WebP/);
});
