// Copies the Emscripten build output into media/wasm for the webview.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "native", "build", "wasm");
const dst = join(root, "media", "wasm");

if (!existsSync(join(src, "exrview.wasm"))) {
  if (existsSync(join(dst, "exrview.wasm"))) process.exit(0);
  console.error("native/build/wasm/exrview.wasm missing: run `npm run build:wasm` first");
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
for (const f of ["exrview.js", "exrview.wasm"]) copyFileSync(join(src, f), join(dst, f));
