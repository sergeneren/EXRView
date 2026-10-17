// Builds the decoder with Emscripten. Uses EMSDK from the environment, or
// ../emsdk next to the repo.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const emsdk = process.env.EMSDK ?? resolve(root, "..", "emsdk");
if (!existsSync(emsdk)) {
  console.error(`emsdk not found at ${emsdk}; set EMSDK`);
  process.exit(1);
}

const native = join(root, "native");
const env = process.platform === "win32"
  ? `"${join(emsdk, "emsdk_env.bat")}" >nul 2>&1 &&`
  : `. "${join(emsdk, "emsdk_env.sh")}" >/dev/null 2>&1 &&`;
const run = (cmd) => execSync(`${env} ${cmd}`, { cwd: native, stdio: "inherit", shell: true });

run("emcmake cmake -S . -B build/wasm -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON");
run("cmake --build build/wasm --target exrview_wasm");
execSync("node scripts/copy-wasm.mjs", { cwd: root, stdio: "inherit" });
