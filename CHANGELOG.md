# Changelog

## 0.2.1 — first Marketplace release

- Viewer for OpenEXR files built on OpenEXR 3.5 (compiled to WebAssembly):
  every compression codec, including DWAA/DWAB, HTJ2K and ZSTD.
- Multi-part and multi-layer files, tiled and scanline, subsampled channels.
- Deep images, flattened front to back, plus a per-pixel sample count view.
- Cryptomatte preview with object/material names under the cursor.
- Decoding in a background worker; all layers are pre-decoded so switching
  is instant.
- HDRView-style toolbar: exposure and blackpoint offset sliders, normalize,
  reset, gamma, false-color colormaps over [0, 1] or [−1, 1].
- Pixel grid and per-pixel values when zoomed in; channel readout under the
  cursor; NaN/Inf shown magenta.
- Header attributes of the selected layer.
- Automatic reload when the file is rewritten on disk.
