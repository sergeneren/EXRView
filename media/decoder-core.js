// Decoder core: wraps the wasm module and does the heavy work (decoding,
// Cryptomatte flattening). It runs inside the webview's decode worker, where
// it is concatenated after the Emscripten glue (exrview.js), and under Node
// for tests via require().
/* global createExrViewModule, WorkerGlobalScope */

function createDecoderCore(M) {
  let handle = 0;
  let header = null;

  const lastError = () => M.UTF8ToString(M._exrv_last_error());

  function close() {
    if (handle) M._exrv_close(handle);
    handle = 0;
    header = null;
  }

  /** Opens an EXR held in `bytes` (Uint8Array) and returns its header. */
  function open(bytes) {
    close();
    const ptr = M._malloc(bytes.length);
    if (!ptr) throw new Error(`out of memory allocating ${bytes.length} bytes`);
    M.HEAPU8.set(bytes, ptr);
    handle = M._exrv_open(ptr, bytes.length); // takes ownership of ptr
    if (!handle) throw new Error(lastError());
    const json = M._exrv_header_json(handle);
    if (!json) {
      const e = lastError();
      close();
      throw new Error(e);
    }
    header = JSON.parse(M.UTF8ToString(json));
    return header;
  }

  function partSize(part) {
    const dw = header.parts[part].dataWindow;
    return { width: dw.max[0] - dw.min[0] + 1, height: dw.max[1] - dw.min[1] + 1 };
  }

  /** Decodes channels of a part to full-resolution float planes. */
  function decode(part, channels) {
    const { width, height } = partSize(part);
    const n = width * height;
    const idxPtr = M._malloc(channels.length * 4);
    const outPtr = M._malloc(channels.length * n * 4);
    try {
      if (!idxPtr || !outPtr) throw new Error("out of memory decoding pixels");
      M.HEAP32.set(channels, idxPtr >> 2);
      const rv = M._exrv_decode_channels(handle, part, idxPtr, channels.length, outPtr);
      if (rv) throw new Error(lastError());
      // HEAPF32 can be replaced by memory growth, so read it only now.
      return channels.map((_, k) => M.HEAPF32.slice((outPtr >> 2) + k * n, (outPtr >> 2) + (k + 1) * n));
    } finally {
      M._free(idxPtr);
      M._free(outPtr);
    }
  }

  /**
   * Decodes all ranks of a Cryptomatte ([{ id:{part,channel}, cov:{...} }])
   * and flattens them to a coverage-weighted colour preview. Returns
   * { width, height, planes: [r, g, b, coverage], ranks: [{ id, cov }] };
   * ranks keep the raw planes for picking.
   */
  function flattenCryptomatte(rankRefs) {
    // One decode per part (rank channels usually share parts).
    const byPart = new Map();
    for (const r of rankRefs)
      for (const ref of [r.id, r.cov]) {
        if (!byPart.has(ref.part)) byPart.set(ref.part, new Set());
        byPart.get(ref.part).add(ref.channel);
      }
    const planes = new Map();
    for (const [part, set] of byPart) {
      const channels = [...set];
      decode(part, channels).forEach((p, k) => planes.set(`${part}:${channels[k]}`, p));
    }
    const ranks = rankRefs.map((r) => ({
      id: planes.get(`${r.id.part}:${r.id.channel}`),
      cov: planes.get(`${r.cov.part}:${r.cov.channel}`),
    }));

    const { width, height } = partSize(rankRefs[0].id.part);
    const n = width * height;
    const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), cov = new Float32Array(n);
    const colors = new Map();
    for (const { id, cov: c } of ranks) {
      for (let i = 0; i < n; i++) {
        const w = c[i];
        if (w === 0) continue;
        const bits = floatBits(id[i]);
        let col = colors.get(bits);
        if (!col) colors.set(bits, (col = idColor(bits)));
        r[i] += w * col[0];
        g[i] += w * col[1];
        b[i] += w * col[2];
        cov[i] += w;
      }
    }
    return { width, height, planes: [r, g, b, cov], ranks };
  }

  return { open, close, decode, flattenCryptomatte };
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function floatBits(v) {
  f32[0] = v;
  return u32[0];
}

/** Stable preview colour from an id's hash bits. */
function idColor(bits) {
  let h = bits;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return [((h >>> 0) & 255) / 255, ((h >>> 8) & 255) / 255, ((h >>> 16) & 255) / 255];
}

// Worker message loop. Messages carry an id; replies echo it with either a
// result or an error. Jobs are synchronous, so they run strictly in order.
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  let core = null;
  const reply = (id, result, transfer = []) => self.postMessage({ id, result }, transfer);

  self.onmessage = async (event) => {
    const msg = event.data;
    try {
      switch (msg.type) {
        case "init": {
          // The glue would fetch the wasm relative to the blob URL; hand it
          // the bytes instead (instantiateWasm is the supported hook).
          const instantiateWasm = (imports, receive) => {
            WebAssembly.instantiate(msg.wasm, imports).then((r) => receive(r.instance));
            return {};
          };
          core = createDecoderCore(await createExrViewModule({ instantiateWasm }));
          reply(msg.id, true);
          break;
        }
        case "open":
          reply(msg.id, core.open(new Uint8Array(msg.buffer)));
          break;
        case "decode": {
          const planes = core.decode(msg.part, msg.channels);
          reply(msg.id, planes, planes.map((p) => p.buffer));
          break;
        }
        case "crypto": {
          const flat = core.flattenCryptomatte(msg.ranks);
          const transfer = [...flat.planes, ...flat.ranks.flatMap((r) => [r.id, r.cov])].map((p) => p.buffer);
          reply(msg.id, flat, [...new Set(transfer)]);
          break;
        }
        default:
          throw new Error(`unknown message ${msg.type}`);
      }
    } catch (e) {
      self.postMessage({ id: msg.id, error: String(e?.message ?? e) });
    }
  };
}

if (typeof module !== "undefined") module.exports = { createDecoderCore };
