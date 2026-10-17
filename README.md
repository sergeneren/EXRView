# EXRView

A VS Code viewer for OpenEXR files, built on the reference OpenEXR library
(compiled to WebAssembly), so it reads everything OpenEXR reads:

- every compression codec (including DWAA/DWAB, HTJ2K, ZSTD)
- multi-part and multi-layer files, tiled and scanline, subsampled channels
- deep images, flattened front to back (plus a per-pixel sample count view)
- Cryptomatte preview with object/material names under the cursor

It runs in desktop VS Code, remote sessions and vscode.dev: the decoder runs
in the webview, not on the host.

## Using the viewer

Open any `.exr` file. Toolbar, left to right:

- **Layer / Channel** — every part and layer; RGB or a single channel.
- **Exposure / Offset** — drag sliders (Shift for fine control, scroll to
  step, double-click to type). Display value = value × 2^exposure + offset.
  `E` / `Shift+E` step the exposure.
- **Normalize** (`N`) — sets exposure and offset so the displayed values span
  [0, 1] (depth, ids, sample counts). **Reset** (`R`) sets both back to 0 and gamma to 1.
- **Tonemapping** — Gamma (value^(1/gamma), then sRGB; `G` / `Shift+G`), or a
  false-color colormap (Viridis, Inferno, Turbo, IceFire, Grayscale) over
  [0, 1] or [−1, 1].
- **Pixel grid / pixel values** — shown once you zoom in far enough.
- **Fit** (`F`), **100%** (`1`), **header attributes** of the selected layer (`I`).

Scroll to zoom at the cursor, drag to pan. The status bar shows the values of
every channel in the current layer under the cursor. NaN/Inf pixels are shown
magenta. The display settings persist while the editor is open, and the view
reloads when the file is rewritten on disk.

## Development

```
npm install
npm run build:wasm   # needs emsdk (EMSDK env var, or ../emsdk)
```
