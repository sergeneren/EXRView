// Decodes files with the wasm build and prints the same per-channel stats as
// exrv_info, so the two can be diffed.
//
//   node native/tools/wasm_smoke.cjs <build/wasm/exrview.js> file.exr...
const fs = require("fs");
const path = require("path");

const SAMPLE_COUNT_CHANNEL = -1;

function stats(plane) {
  let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
  for (const v of plane) {
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
    n++;
  }
  return { mn, mx, mean: sum / n };
}

async function main() {
  const [modPath, ...files] = process.argv.slice(2);
  const createModule = require(path.resolve(modPath));
  const M = await createModule();

  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const ptr = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, ptr);
    const f = M._exrv_open(ptr, bytes.length); // takes ownership of ptr
    if (!f) {
      console.log(`${file}: open failed: ${M.UTF8ToString(M._exrv_last_error())}`);
      continue;
    }
    const header = JSON.parse(M.UTF8ToString(M._exrv_header_json(f)));
    console.log(`== ${path.basename(file)}`);
    for (const part of header.parts) {
      const w = part.dataWindow.max[0] - part.dataWindow.min[0] + 1;
      const h = part.dataWindow.max[1] - part.dataWindow.min[1] + 1;
      const deep = part.storage.startsWith("deep");
      const idx = part.channels.map((_, i) => i);
      if (deep) idx.push(SAMPLE_COUNT_CHANNEL);

      const idxPtr = M._malloc(idx.length * 4);
      M.HEAP32.set(idx, idxPtr >> 2);
      const outPtr = M._malloc(idx.length * w * h * 4);
      const t0 = performance.now();
      const rv = M._exrv_decode_channels(f, part.index, idxPtr, idx.length, outPtr);
      const ms = performance.now() - t0;
      if (rv) {
        console.log(`  part ${part.index}: decode failed: ${M.UTF8ToString(M._exrv_last_error())}`);
      } else {
        console.log(`  part ${part.index}: ${w}x${h} ${part.compression}, ${ms.toFixed(1)} ms`);
        // HEAPF32 may be replaced on memory growth; read it after decoding.
        idx.forEach((ci, k) => {
          const plane = M.HEAPF32.subarray((outPtr >> 2) + k * w * h, (outPtr >> 2) + (k + 1) * w * h);
          const s = stats(plane);
          const name = ci === SAMPLE_COUNT_CHANNEL ? "(sample count)" : part.channels[ci].name;
          console.log(`    ${name.padEnd(24)} min ${s.mn.toPrecision(6).padEnd(12)} max ${s.mx.toPrecision(6).padEnd(12)} mean ${s.mean.toPrecision(6)}`);
        });
      }
      M._free(idxPtr);
      M._free(outPtr);
    }
    M._exrv_close(f);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
