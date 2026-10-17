// Validates Cryptomatte layers with the wasm decoder and writes an RGB
// preview PNG per layer (coverage-weighted id colours).
//
//   node native/tools/crypto_check.cjs <build/wasm/exrview.js> file.exr [out_dir]
//
// Cryptomatte layout (spec v1.2): channels <name>NN.{R,G,B,A} hold
// (id, coverage, id, coverage) for ranks 2*NN and 2*NN+1. Ids are
// MurmurHash3 values stored as float32 bits; the manifest maps names to the
// hex of those bits. Rank channels may be spread across parts.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function floatBits(v) {
  f32[0] = v;
  return u32[0];
}

// Preview colour from the id's hash bits, so an object keeps its colour
// across frames. A final integer mix spreads nearby hashes apart.
function idColor(bits) {
  let h = bits;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return [((h >>> 0) & 255) / 255, ((h >>> 8) & 255) / 255, ((h >>> 16) & 255) / 255];
}

function writePng(file, w, h, rgb) {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) {
      // Display transform: sRGB-ish gamma on the linear preview colour.
      const v = Math.min(1, Math.max(0, rgb[y * w * 3 + x]));
      raw[y * (w * 3 + 1) + 1 + x] = Math.round(255 * Math.pow(v, 1 / 2.2));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

async function main() {
  const [modPath, file, outDir = path.dirname(file)] = process.argv.slice(2);
  const M = await require(path.resolve(modPath))();

  const bytes = fs.readFileSync(file);
  const ptr = M._malloc(bytes.length);
  M.HEAPU8.set(bytes, ptr);
  const handle = M._exrv_open(ptr, bytes.length);
  if (!handle) throw new Error(M.UTF8ToString(M._exrv_last_error()));
  const header = JSON.parse(M.UTF8ToString(M._exrv_header_json(handle)));

  const decode = (part, channelIndices) => {
    const p = header.parts[part];
    const w = p.dataWindow.max[0] - p.dataWindow.min[0] + 1;
    const h = p.dataWindow.max[1] - p.dataWindow.min[1] + 1;
    const idxPtr = M._malloc(channelIndices.length * 4);
    M.HEAP32.set(channelIndices, idxPtr >> 2);
    const outPtr = M._malloc(channelIndices.length * w * h * 4);
    const rv = M._exrv_decode_channels(handle, part, idxPtr, channelIndices.length, outPtr);
    if (rv) throw new Error(M.UTF8ToString(M._exrv_last_error()));
    const planes = channelIndices.map((_, k) =>
      M.HEAPF32.slice((outPtr >> 2) + k * w * h, (outPtr >> 2) + (k + 1) * w * h));
    M._free(idxPtr);
    M._free(outPtr);
    return planes;
  };

  // Gather cryptomatte metadata from every part (writers differ).
  const layers = new Map();
  for (const p of header.parts)
    for (const a of p.attributes) {
      const m = /^cryptomatte\/([0-9a-f]+)\/(\w+)$/.exec(a.name);
      if (!m) continue;
      if (!layers.has(m[1])) layers.set(m[1], {});
      layers.get(m[1])[m[2]] = a.value;
    }

  for (const [key, meta] of layers) {
    const name = meta.name;
    const manifest = meta.manifest ? JSON.parse(meta.manifest) : {};
    const byBits = new Map(Object.entries(manifest).map(([n, hex]) => [parseInt(hex, 16) >>> 0, n]));
    console.log(`\n== ${name} (key ${key}, ${meta.hash}, ${meta.conversion}), manifest: ${byBits.size} entries`);

    // Find rank channels <name>NN.{R,G,B,A} in any part.
    const ranks = [];
    header.parts.forEach((p, pi) => {
      p.channels.forEach((c, ci) => {
        const m = new RegExp(`^${name}(\\d\\d)\\.([RGBA])$`).exec(c.name);
        if (!m) return;
        if (c.type !== "float") console.log(`  WARNING ${c.name} is ${c.type}; ids need float32`);
        const level = parseInt(m[1], 10);
        const rank = level * 2 + (m[2] === "R" || m[2] === "G" ? 0 : 1);
        const role = m[2] === "R" || m[2] === "B" ? "id" : "cov";
        ranks[rank] = ranks[rank] || {};
        ranks[rank][role] = { part: pi, channel: ci };
      });
    });
    const complete = ranks.filter((r) => r && r.id && r.cov);
    console.log(`  ranks: ${complete.length} (parts ${[...new Set(complete.map((r) => r.id.part))].join(", ")})`);
    if (!complete.length) continue;

    const p0 = header.parts[complete[0].id.part];
    const w = p0.dataWindow.max[0] - p0.dataWindow.min[0] + 1;
    const h = p0.dataWindow.max[1] - p0.dataWindow.min[1] + 1;
    const n = w * h;

    const rgb = new Float32Array(n * 3);
    const covSum = new Float32Array(n);
    const seen = new Map(); // bits -> total coverage
    const t0 = performance.now();
    for (const r of complete) {
      const [id] = decode(r.id.part, [r.id.channel]);
      const [cov] = decode(r.cov.part, [r.cov.channel]);
      for (let i = 0; i < n; i++) {
        const c = cov[i];
        if (c === 0) continue;
        const bits = floatBits(id[i]);
        seen.set(bits, (seen.get(bits) || 0) + c);
        covSum[i] += c;
        const col = idColor(bits);
        rgb[i * 3] += c * col[0];
        rgb[i * 3 + 1] += c * col[1];
        rgb[i * 3 + 2] += c * col[2];
      }
    }
    const ms = performance.now() - t0;

    let covered = 0, maxSum = 0, off = 0;
    for (let i = 0; i < n; i++) {
      const s = covSum[i];
      if (s > 0) covered++;
      if (s > maxSum) maxSum = s;
      if (s > 0 && Math.abs(s - 1) > 0.01) off++;
    }
    console.log(`  decoded + flattened ${w}x${h} in ${ms.toFixed(0)} ms`);
    console.log(`  covered pixels: ${(100 * covered / n).toFixed(1)}%, coverage sum max ${maxSum.toFixed(4)}, ` +
      `pixels with sum not ~1: ${off} (${(100 * off / Math.max(1, covered)).toFixed(2)}% of covered)`);
    console.log("  ids found:");
    for (const [bits, total] of [...seen].sort((a, b) => b[1] - a[1])) {
      const hex = bits.toString(16).padStart(8, "0");
      const nm = byBits.get(bits);
      console.log(`    ${hex}  ${(nm ?? "!! NOT IN MANIFEST").padEnd(36)} coverage ${(100 * total / n).toFixed(2)}% of frame`);
    }
    for (const [bits, nm] of byBits)
      if (!seen.has(bits)) console.log(`    ${bits.toString(16).padStart(8, "0")}  ${nm} (in manifest, no pixels)`);

    const png = path.join(outDir, `${path.basename(file, ".exr")}.${name}.preview.png`);
    writePng(png, w, h, rgb);
    console.log(`  preview: ${png}`);
  }
  M._exrv_close(handle);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
