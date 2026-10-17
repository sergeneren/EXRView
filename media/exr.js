// Image model: turns the decoder's header JSON into viewable layers
// (including Cryptomatte and deep pseudo channels). Decoding itself runs in
// the worker (decoder-core.js).

export const SAMPLE_COUNT_CHANNEL = -1;

// ---------------------------------------------------------------------------
// Layers

/**
 * A layer is what the user picks: a set of channels in one part displayed
 * together. kind: "image" (up to RGBA), or "cryptomatte".
 *   { id, label, kind, part, channels: [{ name, index }], rgba: [r,g,b,a] }
 * rgba holds positions into `channels` (or -1).
 */
export function buildLayers(header) {
  const crypto = findCryptomattes(header);
  // Rank groups are shown through the Cryptomatte layer instead.
  const cryptoPrefixes = crypto.map((c) => new RegExp(`^${escapeRe(c.name)}\\d\\d$`));
  const layers = [];

  for (const part of header.parts) {
    const groups = new Map();
    part.channels.forEach((ch, index) => {
      const dot = ch.name.lastIndexOf(".");
      const prefix = dot >= 0 ? ch.name.slice(0, dot) : "";
      const base = dot >= 0 ? ch.name.slice(dot + 1) : ch.name;
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix).push({ name: ch.name, base, index });
    });

    const deep = part.storage.startsWith("deep");
    for (const [prefix, channels] of sortGroups(groups)) {
      if (cryptoPrefixes.some((re) => re.test(prefix))) continue;
      const partName = header.parts.length > 1 ? part.name ?? `part ${part.index}` : "";
      const rgba = pickRgba(channels);
      const isColor = channels[rgba[0]]?.base === "R" && rgba[1] !== rgba[0];
      const label =
        [partName, prefix && prefix !== partName ? prefix : ""].filter(Boolean).join(" / ") ||
        (isColor ? (rgba[3] >= 0 ? "RGBA" : "RGB") : channels.map((c) => c.base).join(", "));
      if (deep) channels.push({ name: "(deep sample count)", base: "count", index: SAMPLE_COUNT_CHANNEL });
      layers.push({
        id: `p${part.index}:${prefix}`,
        label: deep ? `${label} (deep, flattened)` : label,
        kind: "image",
        part: part.index,
        channels,
        rgba,
      });
    }
  }

  for (const c of crypto) {
    if (!c.ranks.length) continue;
    layers.push({ id: `crypto:${c.name}`, label: `Cryptomatte: ${c.name}`, kind: "cryptomatte", crypto: c, channels: [] });
  }
  return layers;
}

function sortGroups(groups) {
  return [...groups].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
}

const RGBA_SETS = [
  ["R", "G", "B", "A"],
  ["r", "g", "b", "a"],
  ["red", "green", "blue", "alpha"],
  ["X", "Y", "Z", null],
  ["x", "y", "z", null],
  ["U", "V", "W", null],
  ["u", "v", "w", null],
];

function pickRgba(channels) {
  const pos = (base) => (base ? channels.findIndex((c) => c.base === base) : -1);
  for (const set of RGBA_SETS) {
    const p = set.map(pos);
    if (p[0] >= 0 && p[1] >= 0) return [p[0], p[1], p[2], p[3]];
  }
  // Luminance/chroma or anything else: single channel shown as grey,
  // preferring Y / A-less channels; alpha if present.
  const a = channels.findIndex((c) => c.base === "A");
  const first = channels.findIndex((c, i) => i !== a && c.index !== SAMPLE_COUNT_CHANNEL);
  const mono = first >= 0 ? first : 0;
  return [mono, mono, mono, a];
}

// ---------------------------------------------------------------------------
// Cryptomatte (spec v1.2)

function findCryptomattes(header) {
  const byKey = new Map();
  for (const p of header.parts)
    for (const a of p.attributes) {
      const m = /^cryptomatte\/([0-9a-f]+)\/(\w+)$/.exec(a.name);
      if (!m) continue;
      if (!byKey.has(m[1])) byKey.set(m[1], { key: m[1] });
      byKey.get(m[1])[m[2]] = a.value;
    }

  const result = [];
  for (const meta of byKey.values()) {
    if (!meta.name) continue;
    let manifest = {};
    try {
      manifest = meta.manifest ? JSON.parse(meta.manifest) : {};
    } catch {
      /* sidecar manifests (manif_file) are not loaded yet */
    }
    const names = new Map(Object.entries(manifest).map(([n, hex]) => [parseInt(hex, 16) >>> 0, n]));

    // Rank channels <name>NN.{R,G,B,A} = (id, cov, id, cov), any part.
    const re = new RegExp(`^${escapeRe(meta.name)}(\\d\\d)\\.([RGBA])$`);
    const ranks = [];
    for (const p of header.parts)
      p.channels.forEach((ch, index) => {
        const m = re.exec(ch.name);
        if (!m) return;
        const rank = parseInt(m[1], 10) * 2 + (m[2] === "R" || m[2] === "G" ? 0 : 1);
        const role = m[2] === "R" || m[2] === "B" ? "id" : "cov";
        ranks[rank] ??= {};
        ranks[rank][role] = { part: p.index, channel: index };
      });
    result.push({ ...meta, names, ranks: ranks.filter((r) => r && r.id && r.cov) });
  }
  return result;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function floatBits(v) {
  f32[0] = v;
  return u32[0];
}

/** Ids under a pixel, largest coverage first: [{ hex, name, coverage }]. */
export function cryptoPick(crypto, flat, x, y) {
  const i = y * flat.width + x;
  const out = new Map();
  for (const { id, cov } of flat.ranks) {
    if (cov[i] === 0) continue;
    const bits = floatBits(id[i]);
    out.set(bits, (out.get(bits) ?? 0) + cov[i]);
  }
  return [...out]
    .sort((a, b) => b[1] - a[1])
    .map(([bits, coverage]) => ({
      hex: bits.toString(16).padStart(8, "0"),
      name: crypto.names.get(bits) ?? null,
      coverage,
    }));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
