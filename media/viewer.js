import { buildLayers, cryptoPick, SAMPLE_COUNT_CHANNEL } from "./exr.js";
import { Decoder } from "./decoder.js";

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const ui = {
  layer: $("layer"), channel: $("channel"), normalize: $("normalize"), reset: $("reset"),
  tonemap: $("tonemap"), colormap: $("colormap"), swatch: $("swatch"), gammaGroup: $("gammaGroup"),
  grid: $("grid"), values: $("values"), fit: $("fit"), oneToOne: $("oneToOne"), info: $("info"),
  viewport: $("viewport"), canvas: $("canvas"), overlay: $("overlay"), message: $("message"), panel: $("panel"),
  pixel: $("pixel"), summary: $("summary"), progress: $("progress"), tooltip: $("tooltip"),
};

// Display settings, kept across reloads and webview restores.
const settings = {
  exposure: 0, offset: 0, gamma: 1, tonemap: "gamma", colormap: "viridis", grid: true, values: true,
  ...vscode.getState()?.settings,
};

const state = {
  name: "",
  decoder: null,   // decode worker client
  header: null,
  layers: [],
  layer: null,
  channel: "rgb",   // "rgb" | position in layer.channels | crypto: "preview" | "coverage"
  image: null,      // { width, height, dataMin:[x,y], textures:[r,g,b,a] (null if absent), mono }
  crypto: null,     // flattened cryptomatte for the current layer
  view: { scale: 1, ox: 0, oy: 0 }, // device px per image px, display-window origin in device px
  fitted: false,
  displayPlanes: null, // planes behind the displayed colour, for Normalize
};

// ---------------------------------------------------------------------------
// Colormaps: display-referred stops, evenly spaced, expanded into 256-entry
// lookup textures.

const COLORMAPS = {
  viridis: { label: "Viridis", stops: ["#440154", "#472c7a", "#3b528b", "#2c728e", "#21918c", "#28ae80", "#5ec962", "#addc30", "#fde725"] },
  inferno: { label: "Inferno", stops: ["#000004", "#1f0c48", "#550f6d", "#88226a", "#ba3655", "#e35933", "#f98e09", "#f9cb35", "#fcffa4"] },
  turbo: { label: "Turbo", stops: ["#30123b", "#4662d7", "#36aaf9", "#1ae4b6", "#72fe5e", "#c8ef34", "#faba39", "#f66b19", "#ca2a04", "#7a0403"] },
  icefire: { label: "IceFire", stops: ["#bde7db", "#5fb0d6", "#3a77c4", "#3b3b8c", "#1e1d22", "#7a1f45", "#c8302a", "#f1864a", "#fde4ac"] },
  gray: { label: "Grayscale", stops: ["#000000", "#ffffff"] },
};

function colormapLut(stops) {
  const rgb = stops.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (rgb.length - 1);
    const k = Math.min(Math.floor(t), rgb.length - 2), f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(rgb[k][c] + (rgb[k + 1][c] - rgb[k][c]) * f);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

const colormapTextures = new Map();
function colormapTexture(name) {
  let tex = colormapTextures.get(name);
  if (!tex) {
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, colormapLut(COLORMAPS[name].stops));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    colormapTextures.set(name, tex);
  }
  return tex;
}

// ---------------------------------------------------------------------------
// WebGL

const gl = ui.canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
const floatLinear = gl && gl.getExtension("OES_texture_float_linear");
let program, uniforms;

function initGl() {
  const vs = `#version 300 es
    void main() {
      vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;
  const fs = `#version 300 es
    precision highp float;
    // One single-channel float texture per displayed channel; uHas says
    // which of R, G, B, A are bound (a mono view uses R only).
    uniform sampler2D uTexR, uTexG, uTexB, uTexA, uCmap;
    uniform bvec4 uHas;
    uniform vec2 uCanvas, uOffset, uDataMin, uDataSize, uDispSize;
    uniform float uScale, uGain, uBlack, uGamma, uChecker, uGrid;
    uniform int uMode, uTonemap; // uTonemap: 0 gamma, 1 colormap [0,1], 2 colormap [-1,1]
    uniform bool uSmooth;
    out vec4 outColor;

    float srgb(float x) { return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
    float srgbInv(float x) { return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
    vec3 toDisplay(vec3 c) {
      c = pow(c, vec3(1.0 / uGamma));
      return vec3(srgb(c.r), srgb(c.g), srgb(c.b));
    }
    // Linear value that the display transform maps to display value d, so
    // the checker looks the same at every gamma.
    float fromDisplay(float d) { return pow(srgbInv(d), uGamma); }
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    bool bad(float x) { return isnan(x) || isinf(x); }
    float fetch(sampler2D t, vec2 q) {
      return uSmooth ? texture(t, q / uDataSize).r : texelFetch(t, ivec2(q), 0).r;
    }

    void main() {
      vec2 frag = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
      vec2 p = (frag - uOffset) / uScale;           // display-window pixels
      bool inDisp = all(greaterThanEqual(p, vec2(0))) && all(lessThan(p, uDispSize));
      float edge = 1.0 / uScale;
      bool border = inDisp && (p.x < edge || p.y < edge || p.x > uDispSize.x - edge || p.y > uDispSize.y - edge);
      vec2 cell = floor(frag / uChecker);
      float checker = mod(cell.x + cell.y, 2.0) < 1.0 ? 0.169 : 0.102; // #2b2b2b / #1a1a1a
      vec2 q = p - uDataMin;                        // data-window pixels
      bool inData = all(greaterThanEqual(q, vec2(0))) && all(lessThan(q, uDataSize));

      if (!inData) {
        // Empty display-window area is transparent: show the checker.
        vec3 bg = inDisp ? vec3(checker) : vec3(0.11);
        outColor = vec4(border ? vec3(0.6) : bg, 1.0);
        return;
      }

      vec3 c;
      float a = 1.0;
      if (uMode == 1) c = vec3(fetch(uTexR, q));
      else {
        c = vec3(fetch(uTexR, q), uHas.g ? fetch(uTexG, q) : 0.0, uHas.b ? fetch(uTexB, q) : 0.0);
        if (uHas.a) a = fetch(uTexA, q);
      }
      if (bad(c.r) || bad(c.g) || bad(c.b) || bad(a)) { outColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
      c = c * uGain + uBlack;
      a = clamp(a, 0.0, 1.0);
      if (uTonemap == 0) {
        // Premultiplied "over" the checker, in linear light.
        c = toDisplay(max(c, 0.0) + (1.0 - a) * fromDisplay(checker));
      } else {
        float v = uMode == 1 ? c.r : luma(c);
        float t = uTonemap == 1 ? v : v * 0.5 + 0.5;
        c = mix(vec3(checker), texture(uCmap, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb, a);
      }
      if (uGrid > 0.0) {
        // Pixel grid, one device pixel wide, contrasting with the pixel.
        vec2 f = fract(p) * uScale;
        if (min(f.x, f.y) < 1.0) c = mix(c, vec3(luma(c) > 0.5 ? 0.0 : 1.0), 0.3 * uGrid);
      }
      if (border) c = mix(c, vec3(0.6), 0.5);
      outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`;
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  uniforms = Object.fromEntries(
    ["uTexR", "uTexG", "uTexB", "uTexA", "uCmap", "uHas", "uCanvas", "uOffset", "uDataMin", "uDataSize", "uDispSize",
      "uScale", "uGain", "uBlack", "uGamma", "uChecker", "uGrid", "uMode", "uTonemap", "uSmooth"].map((n) => [n, gl.getUniformLocation(program, n)]),
  );
}

// GPU copies of channel planes, uploaded once and kept (least recently used
// evicted past the budget), so switching layers/channels is just a rebind.
const TEXTURE_BUDGET = 1.5 * 1024 ** 3;
const textures = new Map(); // key -> { tex, bytes }
let textureBytes = 0;

function planeTexture(key, plane, width, height) {
  let entry = textures.get(key);
  if (entry) {
    textures.delete(key); // re-insert as most recently used
    textures.set(key, entry);
    return entry.tex;
  }
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (width > max || height > max) throw new Error(`${width}x${height} exceeds the GPU texture limit (${max})`);
  const bytes = width * height * 4;
  for (const [k, e] of textures) {
    if (textureBytes + bytes <= TEXTURE_BUDGET) break;
    gl.deleteTexture(e.tex);
    textureBytes -= e.bytes;
    textures.delete(k);
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, plane);
  const filter = floatLinear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  textures.set(key, { tex, bytes });
  textureBytes += bytes;
  return tex;
}

function clearTextures() {
  for (const e of textures.values()) gl.deleteTexture(e.tex);
  textures.clear();
  textureBytes = 0;
}

let frameRequested = false;
function requestDraw() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    draw();
  });
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(ui.viewport.clientWidth * dpr));
  const h = Math.max(1, Math.round(ui.viewport.clientHeight * dpr));
  for (const c of [ui.canvas, ui.overlay]) {
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0.11, 0.11, 0.11, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const img = state.image;
  overlay.clearRect(0, 0, w, h);
  if (!img) return;

  const disp = displaySize();
  gl.useProgram(program);
  ["uTexR", "uTexG", "uTexB", "uTexA"].forEach((name, unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, img.textures[unit] ?? img.textures[0]);
    gl.uniform1i(uniforms[name], unit);
  });
  gl.activeTexture(gl.TEXTURE4);
  gl.bindTexture(gl.TEXTURE_2D, colormapTexture(settings.colormap));
  gl.uniform1i(uniforms.uCmap, 4);
  gl.uniform1i(uniforms.uTonemap, { gamma: 0, cmap01: 1, cmap11: 2 }[settings.tonemap]);
  gl.uniform4i(uniforms.uHas, ...img.textures.map((t) => (t ? 1 : 0)));
  gl.uniform1f(uniforms.uChecker, 10 * dpr);
  gl.uniform2f(uniforms.uCanvas, w, h);
  gl.uniform2f(uniforms.uOffset, state.view.ox, state.view.oy);
  gl.uniform1f(uniforms.uScale, state.view.scale);
  gl.uniform2f(uniforms.uDataMin, img.dataMin[0], img.dataMin[1]);
  gl.uniform2f(uniforms.uDataSize, img.width, img.height);
  gl.uniform2f(uniforms.uDispSize, disp.width, disp.height);
  gl.uniform1i(uniforms.uMode, img.mono ? 1 : 0);
  gl.uniform1f(uniforms.uGain, Math.pow(2, settings.exposure));
  gl.uniform1f(uniforms.uBlack, settings.offset);
  gl.uniform1f(uniforms.uGamma, settings.gamma);
  // The grid fades in from 8 to 16 screen pixels per image pixel.
  const cssScale = state.view.scale / dpr;
  gl.uniform1f(uniforms.uGrid, settings.grid ? Math.min(1, Math.max(0, (cssScale - 8) / 8)) : 0);
  gl.uniform1i(uniforms.uSmooth, floatLinear && state.view.scale < 1 ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (settings.values) drawValues(w, h, dpr);
}

// ---------------------------------------------------------------------------
// Pixel values, printed into each pixel once it is large enough to hold them

const overlay = ui.overlay.getContext("2d");
const monoFont = getComputedStyle(document.body).getPropertyValue("--vscode-editor-font-family").trim() || "monospace";

function fmtCell(v) {
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "+Inf" : "-Inf";
  if (v !== 0 && (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-4)) return v.toExponential(2);
  return v.toFixed(5);
}

// The value lines printed for pixel i (data-window index) at (qx, qy).
function cellLines(qx, qy, i) {
  if (state.layer.kind === "cryptomatte") {
    // Names are often paths: keep the last segment, which fits in a cell.
    return cryptoPick(state.layer.crypto, state.crypto, qx, qy).slice(0, 2).map((d) => {
      let n = d.name?.split("/").filter(Boolean).pop() ?? d.name ?? d.hex;
      if (n.length > 14) n = n.slice(0, 13) + "…";
      return `${n} ${(d.coverage * 100).toFixed(0)}%`;
    });
  }
  const rows = state.cellRows;
  const pad = Math.max(...rows.map((r) => r.name.length)) + 2;
  return rows.map((r) => `${(r.name + ":").padEnd(pad)}${r.name === "samples" ? r.plane[i] : fmtCell(r.plane[i])}`);
}

function drawValues(w, h, dpr) {
  const img = state.image;
  const { scale, ox, oy } = state.view;
  const isCrypto = state.layer.kind === "cryptomatte";
  if (!isCrypto && !state.cellRows?.length) return;
  const fontPx = Math.round(11 * dpr);
  const lineH = Math.round(fontPx * 1.3);
  overlay.font = `${fontPx}px ${monoFont}`;
  const charW = overlay.measureText("0").width;
  const lines = 1 + (isCrypto ? 2 : state.cellRows.length);
  const chars = isCrypto ? 20 : Math.max(...state.cellRows.map((r) => r.name.length)) + 2 + 10;
  if (scale < chars * charW + 8 * dpr || scale < lines * lineH + 8 * dpr) return;

  const disp = displaySize();
  const x0 = Math.max(0, Math.floor(-ox / scale) - img.dataMin[0]);
  const y0 = Math.max(0, Math.floor(-oy / scale) - img.dataMin[1]);
  const x1 = Math.min(img.width, Math.ceil((w - ox) / scale) - img.dataMin[0]);
  const y1 = Math.min(img.height, Math.ceil((h - oy) / scale) - img.dataMin[1]);
  overlay.textBaseline = "middle";
  overlay.lineJoin = "round";
  overlay.lineWidth = 3 * dpr;
  overlay.strokeStyle = "rgba(0, 0, 0, 0.75)";
  overlay.fillStyle = "#fff";
  for (let qy = y0; qy < y1; qy++) {
    for (let qx = x0; qx < x1; qx++) {
      const px = qx + img.dataMin[0], py = qy + img.dataMin[1];
      const text = [`(${px + disp.min[0]},${py + disp.min[1]})`, ...cellLines(qx, qy, qy * img.width + qx)];
      const cx = ox + (px + 0.5) * scale, cy = oy + (py + 0.5) * scale;
      const width = Math.max(...text.slice(1).map((t) => t.length), 0) * charW;
      text.forEach((t, k) => {
        // The coordinates are centred; the values are left aligned as a block.
        const x = k === 0 ? cx - (t.length * charW) / 2 : cx - width / 2;
        const y = cy + (k - (text.length - 1) / 2) * lineH;
        overlay.strokeText(t, x, y);
        overlay.fillText(t, x, y);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Image selection

function currentPart() {
  const layer = state.layer;
  const index = layer.kind === "cryptomatte" ? layer.crypto.ranks[0].id.part : layer.part;
  return state.header.parts[index];
}

function displaySize() {
  const dw = currentPart().displayWindow;
  return { width: dw.max[0] - dw.min[0] + 1, height: dw.max[1] - dw.min[1] + 1, min: dw.min };
}

function populateLayers() {
  ui.layer.replaceChildren(
    ...state.layers.map((l) => new Option(l.label, l.id)),
  );
}

function populateChannels() {
  const layer = state.layer;
  const options = [];
  if (layer.kind === "cryptomatte") {
    options.push(new Option("Preview", "preview"), new Option("Coverage", "coverage"));
  } else {
    const [r, g, b] = layer.rgba;
    if (r !== g || g !== b) options.push(new Option("RGB", "rgb"));
    layer.channels.forEach((c, i) => options.push(new Option(c.index === SAMPLE_COUNT_CHANNEL ? c.name : c.base, String(i))));
  }
  ui.channel.replaceChildren(...options);
  const values = options.map((o) => o.value);
  if (!values.includes(state.channel)) state.channel = values[0];
  ui.channel.value = state.channel;
}

function channelInLayer(from, to, channel) {
  if (!from || from.kind === "cryptomatte" || to.kind === "cryptomatte" || !/^\d+$/.test(channel)) return channel;
  const base = from.channels[Number(channel)]?.base;
  const i = to.channels.findIndex((c) => c.base === base);
  return i >= 0 ? String(i) : null;
}

async function selectLayer(id, channel) {
  const previous = state.layer;
  state.layer = state.layers.find((l) => l.id === id) ?? state.layers[0];
  ui.layer.value = state.layer.id;
  state.channel = channel ?? channelInLayer(previous, state.layer, state.channel);
  populateChannels();
  renderInfo();
  await showImage();
}

let showGeneration = 0;
async function showImage() {
  const layer = state.layer;
  const decoder = state.decoder;
  const generation = ++showGeneration;
  const isCrypto = layer.kind === "cryptomatte";
  const channelIndices = isCrypto ? [] : layer.channels.map((c) => c.index);

  // Decoding runs in the worker, so the UI stays live; the request jumps
  // ahead of background prefetches. Cached layers resolve immediately.
  const ready = isCrypto ? decoder.hasCrypto(layer.crypto.name) : decoder.hasPlanes(layer.part, channelIndices);
  const t0 = performance.now();
  try {
    if (!ready) {
      busy(`Decoding ${layer.label}…`);
      await (isCrypto ? decoder.requestCrypto(layer.crypto, true) : decoder.requestPlanes(layer.part, channelIndices, true));
      if (generation !== showGeneration) return; // superseded by a newer selection
    }

    let width, height, mono, planes, keys;
    const part = currentPart();
    const disp = part.displayWindow.min;
    const dataMin = [part.dataWindow.min[0] - disp[0], part.dataWindow.min[1] - disp[1]];

    if (isCrypto) {
      const name = layer.crypto.name;
      const flat = decoder.getCrypto(name);
      state.crypto = flat;
      state.readout = null;
      ({ width, height } = flat);
      const [r, g, b, cov] = flat.planes;
      const k = `crypto:${name}:`;
      mono = state.channel === "coverage";
      planes = mono ? [cov, null, null, null] : [r, g, b, cov]; // preview is premultiplied by coverage
      keys = mono ? [k + "cov"] : [k + "r", k + "g", k + "b", k + "cov"];
      state.cellRows = null;
    } else {
      ({ width, height } = partSize(layer.part));
      // The whole layer is decoded together (deep parts flatten once),
      // which also feeds the pixel readout.
      const all = decoder.getPlanes(layer.part, channelIndices);
      state.readout = layer.channels.map((c, k) => ({ name: c.index === SAMPLE_COUNT_CHANNEL ? "samples" : c.base, plane: all[k] }));
      const positions = state.channel === "rgb" ? layer.rgba : [Number(state.channel)];
      mono = positions.length === 1;
      planes = [0, 1, 2, 3].map((i) => (positions[i] >= 0 ? all[positions[i]] : null));
      keys = [0, 1, 2, 3].map((i) => (positions[i] >= 0 ? `${layer.part}:${layer.channels[positions[i]].index}` : null));
      state.cellRows = [...new Set(positions.filter((p) => p >= 0))].map((p) => state.readout[p]);
    }

    const textures = planes.map((p, i) => (p ? planeTexture(keys[i], p, width, height) : null));
    state.image = { width, height, dataMin, textures, mono };
    state.displayPlanes = mono ? [planes[0]] : planes.slice(0, 3).filter(Boolean);
    if (!state.fitted) fit();
    hideMessage();
    const ms = performance.now() - t0;
    ui.summary.textContent = `${state.name} · ${width}×${height} · ${part.compression} · ${state.header.parts.length} part(s)` +
      (ready ? "" : ` · decoded in ${ms.toFixed(0)} ms`);
    requestDraw();
  } catch (e) {
    if (generation === showGeneration && e?.message !== "superseded") error(e);
  }
}

function partSize(part) {
  const dw = state.header.parts[part].dataWindow;
  return { width: dw.max[0] - dw.min[0] + 1, height: dw.max[1] - dw.min[1] + 1 };
}

// Background decode of every layer, so switching is instant once the user
// starts browsing. Image layers are grouped per part (one pass decodes all
// of a part's layers); Cryptomattes go last since they are the largest.
const PREFETCH_BUDGET = 2 * 1024 ** 3;
function startPrefetch() {
  const perPart = new Map();
  for (const l of state.layers) {
    if (l.kind !== "image") continue;
    if (!perPart.has(l.part)) perPart.set(l.part, new Set());
    for (const c of l.channels) perPart.get(l.part).add(c.index);
  }
  const tasks = [];
  for (const [part, set] of perPart) {
    const channels = [...set];
    const { width, height } = partSize(part);
    tasks.push({ estimate: width * height * 4 * channels.length, run: (d) => d.requestPlanes(part, channels) });
  }
  for (const l of state.layers) {
    if (l.kind !== "cryptomatte") continue;
    const { width, height } = partSize(l.crypto.ranks[0].id.part);
    tasks.push({ estimate: width * height * 4 * (4 + 2 * l.crypto.ranks.length), run: (d) => d.requestCrypto(l.crypto) });
  }
  state.decoder.prefetchAll(tasks, PREFETCH_BUDGET);
}

function showProgress({ done, total, skipped }) {
  const note = skipped ? ` (${skipped} left for on demand: memory budget)` : "";
  ui.progress.textContent = done < total ? `Decoding layers in background ${done}/${total}${note}` : note.trim();
}

const ranges = new WeakMap(); // plane -> [min, max] of finite values
function combinedRange(planes) {
  let mn = Infinity, mx = -Infinity;
  for (const p of planes) {
    let r = ranges.get(p);
    if (!r) {
      let a = Infinity, b = -Infinity;
      for (let i = 0; i < p.length; i++) {
        const v = p[i];
        if (v - v !== 0) continue; // NaN or Inf
        if (v < a) a = v;
        if (v > b) b = v;
      }
      ranges.set(p, (r = [a, b]));
    }
    mn = Math.min(mn, r[0]);
    mx = Math.max(mx, r[1]);
  }
  return Number.isFinite(mn) && Number.isFinite(mx) ? [mn, mx] : [0, 1];
}

// ---------------------------------------------------------------------------
// View

function fit() {
  const dpr = window.devicePixelRatio || 1;
  const w = ui.viewport.clientWidth * dpr, h = ui.viewport.clientHeight * dpr;
  const disp = displaySize();
  const scale = Math.min(w / disp.width, h / disp.height) * 0.95;
  state.view = { scale, ox: (w - disp.width * scale) / 2, oy: (h - disp.height * scale) / 2 };
  state.fitted = true;
  requestDraw();
}

function oneToOne() {
  const dpr = window.devicePixelRatio || 1;
  const w = ui.viewport.clientWidth * dpr, h = ui.viewport.clientHeight * dpr;
  zoomAt(w / 2, h / 2, dpr / state.view.scale);
}

function zoomAt(x, y, factor) {
  const v = state.view;
  const scale = Math.min(256, Math.max(1 / 64, v.scale * factor));
  const f = scale / v.scale;
  state.view = { scale, ox: x - (x - v.ox) * f, oy: y - (y - v.oy) * f };
  requestDraw();
}

function devicePos(e) {
  const r = ui.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
}

ui.canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [x, y] = devicePos(e);
  zoomAt(x, y, Math.pow(1.0015, -e.deltaY));
}, { passive: false });

let drag = null;
ui.canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, ox: state.view.ox, oy: state.view.oy };
  ui.canvas.setPointerCapture(e.pointerId);
});
ui.canvas.addEventListener("pointerup", () => (drag = null));
ui.canvas.addEventListener("pointermove", (e) => {
  if (drag) {
    const dpr = window.devicePixelRatio || 1;
    state.view.ox = drag.ox + (e.clientX - drag.x) * dpr;
    state.view.oy = drag.oy + (e.clientY - drag.y) * dpr;
    requestDraw();
  }
  readout(e);
});
ui.canvas.addEventListener("pointerleave", () => (ui.pixel.textContent = ""));

function readout(e) {
  const img = state.image;
  if (!img) return;
  const [dx, dy] = devicePos(e);
  const px = Math.floor((dx - state.view.ox) / state.view.scale);
  const py = Math.floor((dy - state.view.oy) / state.view.scale);
  const disp = displaySize();
  const qx = px - img.dataMin[0], qy = py - img.dataMin[1];
  const coords = `${px + disp.min[0]}, ${py + disp.min[1]}`;
  if (qx < 0 || qy < 0 || qx >= img.width || qy >= img.height) {
    ui.pixel.textContent = coords;
    return;
  }
  const i = qy * img.width + qx;
  if (state.layer.kind === "cryptomatte") {
    const ids = cryptoPick(state.layer.crypto, state.crypto, qx, qy);
    ui.pixel.textContent = `${coords}  ` + (ids.length
      ? ids.map((d) => `${d.name ?? `?${d.hex}`} ${(d.coverage * 100).toFixed(1)}%`).join("  ·  ")
      : "(no ids)");
    return;
  }
  const values = (state.readout ?? []).map((c) => `${c.name} ${c.name === "samples" ? c.plane[i] : fmt(c.plane[i])}`);
  ui.pixel.textContent = `${coords}  ${values.join("  ")}`;
}

function fmt(v) {
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "+Inf" : "-Inf";
  if (v !== 0 && (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3)) return v.toExponential(3);
  return v.toFixed(4);
}

// ---------------------------------------------------------------------------
// Info panel

// Header info for the selected layer: the part(s) it lives in, with only
// the layer's own channels listed.
function renderInfo() {
  const header = state.header;
  const layer = state.layer;
  const perPart = new Map(); // part index -> channel indices in the layer
  const add = (part, channel) => {
    if (!perPart.has(part)) perPart.set(part, new Set());
    if (channel !== SAMPLE_COUNT_CHANNEL) perPart.get(part).add(channel);
  };
  if (layer.kind === "cryptomatte") {
    for (const r of layer.crypto.ranks) for (const c of [r.id, r.cov]) add(c.part, c.channel);
  } else {
    for (const c of layer.channels) add(layer.part, c.index);
  }
  const frag = document.createDocumentFragment();
  const h = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  frag.append(h("h3", layer.label));
  frag.append(h("div", `${header.library} · EXR v${header.version} · ${header.parts.length} part(s) in file`, "muted"));
  for (const [index, channels] of perPart) {
    const part = header.parts[index];
    const own = part.channels.filter((_, i) => channels.has(i));
    frag.append(h("h3", `Part ${part.index}${part.name ? `: ${part.name}` : ""}`));
    frag.append(h("div", `${part.storage} · ${part.compression} · ${own.length} of ${part.channels.length} channels in this layer`, "muted"));
    const chans = h("div", own.map((c) => `${c.name} (${c.type}${c.xSampling > 1 || c.ySampling > 1 ? ` ${c.xSampling}x${c.ySampling}` : ""})`).join(", "), "channels");
    frag.append(chans);
    const table = h("table");
    for (const a of part.attributes) {
      const tr = h("tr");
      const value = typeof a.value === "string" ? a.value : JSON.stringify(a.value);
      const td = h("td", value.length > 300 ? value.slice(0, 300) + "…" : value);
      td.title = value;
      tr.append(h("th", a.name), h("td", a.type, "muted"), td);
      table.append(tr);
    }
    frag.append(table);
  }
  ui.panel.replaceChildren(frag);
}

// ---------------------------------------------------------------------------
// Wiring

ui.layer.addEventListener("change", () => selectLayer(ui.layer.value));
ui.channel.addEventListener("change", () => {
  state.channel = ui.channel.value;
  showImage();
});
ui.normalize.addEventListener("click", normalizeExposure);
ui.reset.addEventListener("click", resetTonemap);
ui.tonemap.addEventListener("change", () => update({ tonemap: ui.tonemap.value }));
ui.colormap.addEventListener("change", () => update({ colormap: ui.colormap.value }));
ui.grid.addEventListener("click", () => update({ grid: !settings.grid }));
ui.values.addEventListener("click", () => update({ values: !settings.values }));
ui.fit.addEventListener("click", fit);
ui.oneToOne.addEventListener("click", oneToOne);
ui.info.addEventListener("click", toggleInfo);
window.addEventListener("resize", requestDraw);
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "f") fit();
  else if (key === "1") oneToOne();
  else if (key === "i") toggleInfo();
  else if (key === "n") normalizeExposure();
  else if (key === "r") resetTonemap();
  else if (key === "e") update({ exposure: settings.exposure + (e.shiftKey ? -0.25 : 0.25) });
  else if (key === "g") update({ gamma: Math.max(0.1, settings.gamma + (e.shiftKey ? -0.1 : 0.1)) });
});

// ---------------------------------------------------------------------------
// Tonemapping controls

// A drag slider in the style of an ImGui SliderFloat, with the label and
// value drawn inside. Dragging is relative (a click does not jump), Shift
// drags 10x finer, the wheel and arrow keys step, double-click or Enter
// types a value.
class Slider {
  constructor(el, { label, min, max, step, wheel, format, onChange }) {
    Object.assign(this, { el, label, min, max, step, format, onChange });
    el.tabIndex = 0;
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", label);
    this.handle = el.appendChild(document.createElement("div"));
    this.handle.className = "handle";
    this.text = el.appendChild(document.createElement("div"));
    this.text.className = "text";
    const nudge = (dir, fine) => this.change(this.value + dir * wheel * (fine ? 0.1 : 1));
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.input) return;
      drag = { x: e.clientX, value: this.value };
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const perPx = ((this.max - this.min) / el.clientWidth) * (e.shiftKey ? 0.1 : 1);
      // Values beyond the nominal range (set by Normalize) stay reachable.
      const lo = Math.min(this.min, drag.value), hi = Math.max(this.max, drag.value);
      this.change(Math.min(hi, Math.max(lo, drag.value + (e.clientX - drag.x) * perPx)));
    });
    const end = () => {
      drag = null;
      el.classList.remove("dragging");
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey);
    }, { passive: false });
    el.addEventListener("keydown", (e) => {
      if (this.input) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        nudge(e.key === "ArrowRight" ? 1 : -1, e.shiftKey);
      } else if (e.key === "Enter") {
        e.stopPropagation();
        this.edit();
      }
    });
    el.addEventListener("dblclick", () => this.edit());
  }

  change(v) {
    const snapped = Math.round(v / this.step) * this.step;
    if (snapped !== this.value) this.onChange(snapped);
  }

  set(v) {
    this.value = v;
    this.text.textContent = `${this.label}: ${this.format(v)}`;
    this.el.setAttribute("aria-valuenow", String(v));
    const t = Math.min(1, Math.max(0, (v - this.min) / (this.max - this.min)));
    this.handle.style.left = `calc(4px + ${t} * (100% - 8px))`;
  }

  edit() {
    const input = (this.input = document.createElement("input"));
    input.value = String(Number(this.value.toFixed(6)));
    this.el.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = Number(input.value);
      input.remove();
      this.input = null;
      this.el.focus();
      if (commit && input.value.trim() !== "" && Number.isFinite(v)) this.onChange(v);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }
}

const signed = (digits) => (v) => {
  const a = Math.abs(v);
  return `${v < 0 ? "−" : "+"}${a >= 1e4 || (a > 0 && a < 10 ** -digits) ? a.toExponential(1) : a.toFixed(digits)}`;
};
const sliders = {
  exposure: new Slider($("exposure"), { label: "Exposure", min: -10, max: 10, step: 0.01, wheel: 0.25, format: signed(2), onChange: (v) => update({ exposure: v }) }),
  offset: new Slider($("offset"), { label: "Offset", min: -1, max: 1, step: 0.001, wheel: 0.01, format: signed(2), onChange: (v) => update({ offset: v }) }),
  gamma: new Slider($("gamma"), { label: "Gamma", min: 0.1, max: 5, step: 0.001, wheel: 0.1, format: (v) => v.toFixed(3), onChange: (v) => update({ gamma: Math.max(0.01, v) }) }),
};

ui.colormap.replaceChildren(...Object.entries(COLORMAPS).map(([k, c]) => new Option(c.label, k)));

function update(changes) {
  Object.assign(settings, changes);
  if (!COLORMAPS[settings.colormap]) settings.colormap = "viridis";
  if (!["gamma", "cmap01", "cmap11"].includes(settings.tonemap)) settings.tonemap = "gamma";
  for (const [k, s] of Object.entries(sliders)) s.set(settings[k]);
  ui.tonemap.value = settings.tonemap;
  ui.colormap.value = settings.colormap;
  const isCmap = settings.tonemap !== "gamma";
  ui.colormap.hidden = ui.swatch.hidden = !isCmap;
  ui.swatch.style.background = `linear-gradient(to right, ${COLORMAPS[settings.colormap].stops.join(", ")})`;
  ui.gammaGroup.classList.toggle("disabled", isCmap);
  ui.grid.classList.toggle("active", settings.grid);
  ui.values.classList.toggle("active", settings.values);
  try {
    vscode.setState({ ...vscode.getState(), settings });
  } catch {}
  requestDraw();
}

// Exposure and offset that map the displayed values' range to [0, 1].
function normalizeExposure() {
  if (!state.displayPlanes?.length) return;
  const [mn, mx] = combinedRange(state.displayPlanes);
  if (mx - mn > 1e-30 * Math.max(1, Math.abs(mx))) {
    const gain = 1 / (mx - mn);
    update({ exposure: Math.log2(gain), offset: -mn * gain });
  } else {
    // Constant image: scale its value to 1 (or leave 0 at 0).
    update({ exposure: mx ? -Math.log2(Math.abs(mx)) : 0, offset: 0 });
  }
}

function resetTonemap() {
  update({ exposure: 0, offset: 0, gamma: 1 });
}

// ---------------------------------------------------------------------------
// Tooltips: title, shortcut and description from data-tip / data-key /
// data-desc on the hovered element or its group.

let tipTimer = 0, tipFor = null;
document.addEventListener("pointerover", (e) => {
  const el = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
  if (el === tipFor) return;
  tipFor = el;
  clearTimeout(tipTimer);
  ui.tooltip.hidden = true;
  if (el) tipTimer = setTimeout(() => showTip(el), 500);
});
document.addEventListener("pointerdown", () => {
  clearTimeout(tipTimer);
  ui.tooltip.hidden = true;
});

function showTip(el) {
  const title = document.createElement("div");
  title.textContent = el.dataset.tip;
  if (el.dataset.key) {
    const key = title.appendChild(document.createElement("span"));
    key.className = "key";
    key.textContent = `(${el.dataset.key})`;
  }
  const parts = [title];
  if (el.dataset.desc) {
    const desc = document.createElement("div");
    desc.className = "desc";
    desc.textContent = el.dataset.desc;
    parts.push(desc);
  }
  ui.tooltip.replaceChildren(...parts);
  ui.tooltip.hidden = false;
  const r = el.getBoundingClientRect(), t = ui.tooltip.getBoundingClientRect();
  ui.tooltip.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - t.width - 4))}px`;
  ui.tooltip.style.top = `${r.bottom + 6 + t.height < window.innerHeight ? r.bottom + 6 : Math.max(4, r.top - t.height - 6)}px`;
}

function toggleInfo() {
  ui.panel.hidden = !ui.panel.hidden;
  ui.info.classList.toggle("active", !ui.panel.hidden);
  requestDraw();
}

function busy(text) {
  ui.message.textContent = text;
  ui.message.className = "visible";
}
function hideMessage() {
  ui.message.className = "";
}
function error(e) {
  console.error(e);
  ui.message.textContent = `Error: ${e?.message ?? e}`;
  ui.message.className = "visible error";
}
let loadGeneration = 0;
async function load(name, buffer, isReload) {
  const generation = ++loadGeneration;
  try {
    busy(`Opening ${name}…`);
    const keep = isReload && state.layer ? { layer: state.layer.id, channel: state.channel } : null;
    const header = await state.decoder.open(buffer); // drops the old file's planes
    if (generation !== loadGeneration) return;
    state.crypto = null;
    clearTextures();
    state.name = name;
    state.header = header;
    state.layers = buildLayers(header);
    if (!state.layers.length) throw new Error("no displayable channels");
    if (!isReload) state.fitted = false;
    populateLayers();
    await selectLayer(keep?.layer ?? state.layers[0].id, keep?.channel ?? "rgb");
    if (generation === loadGeneration) startPrefetch();
  } catch (e) {
    if (generation === loadGeneration) error(e);
  }
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "load" || msg.type === "reload") {
    const buffer = msg.buffer;
    if (!(buffer instanceof ArrayBuffer)) error(`expected file data as ArrayBuffer, got ${Object.prototype.toString.call(buffer)}`);
    else if (buffer.byteLength === 0) error("the file is empty");
    else load(msg.name, buffer, msg.type === "reload");
  }
  else if (msg.type === "error") error(msg.message);
});

update({});
new ResizeObserver(requestDraw).observe(ui.viewport);

async function start() {
  if (!gl) throw new Error("WebGL2 is not available in this webview");
  initGl();
  busy("Loading decoder…");
  state.decoder = await Decoder.create(globalThis.EXRVIEW_URLS);
  state.decoder.onProgress = showProgress;
  vscode.postMessage({ type: "ready" });
}
start().catch(error);
