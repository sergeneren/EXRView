// Headless check of the webview's decode path under Node: the same decoder
// core the worker runs (media/decoder-core.js) plus the layer model
// (media/exr.js). Lists each file's layers and decodes every one of them.
//
//   node scripts/model_smoke.mjs file.exr...
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";

const require = createRequire(import.meta.url);
const createModule = require("../media/wasm/exrview.js");
const { createDecoderCore } = require("../media/decoder-core.js");
const { buildLayers, cryptoPick } = await import("../media/exr.js");

const core = createDecoderCore(await createModule());
let failures = 0;
for (const path of process.argv.slice(2)) {
  console.log(`== ${basename(path)}`);
  const header = core.open(new Uint8Array(readFileSync(path)));
  for (const layer of buildLayers(header)) {
    const t0 = performance.now();
    try {
      let detail;
      if (layer.kind === "cryptomatte") {
        const flat = core.flattenCryptomatte(layer.crypto.ranks);
        // Pick the pixel with the most coverage to exercise name lookup.
        const cov = flat.planes[3];
        let best = 0;
        for (let i = 0; i < cov.length; i++) if (cov[i] > cov[best]) best = i;
        const ids = cryptoPick(layer.crypto, flat, best % flat.width, Math.floor(best / flat.width));
        detail = `${layer.crypto.ranks.length} ranks, sample pick: ${ids.map((d) => `${d.name ?? "?" + d.hex} ${(d.coverage * 100).toFixed(0)}%`).join(", ")}`;
      } else {
        core.decode(layer.part, layer.channels.map((c) => c.index));
        const rgba = layer.rgba.map((p) => (p >= 0 ? layer.channels[p].base : "-")).join("");
        detail = `[${layer.channels.map((c) => c.base).join(" ")}] rgba=${rgba}`;
      }
      console.log(`  ${layer.label.padEnd(44)} ${detail}  (${(performance.now() - t0).toFixed(0)} ms)`);
    } catch (e) {
      failures++;
      console.log(`  ${layer.label.padEnd(44)} FAILED: ${e.message}`);
    }
  }
}
core.close();
process.exit(failures ? 1 : 0);
