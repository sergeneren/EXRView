"""Generates synthetic EXRs covering every compression codec and the layouts
the viewer must handle (multi-layer, multi-part, tiled, subsampled).

    pip install OpenEXR numpy
    python make_test_images.py <out_dir>
"""
import os
import sys

import numpy as np
import OpenEXR

W, H = 320, 200


def gradient(dtype=np.float32):
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    r = x / (W - 1) * 4.0  # HDR ramp up to 4.0
    g = y / (H - 1)
    b = 0.5 + 0.5 * np.sin(x / 9.0) * np.cos(y / 7.0)
    return [c.astype(dtype) for c in (r, g, b)]


def tiles(size):
    t = OpenEXR.TileDescription()
    t.xSize = t.ySize = size
    t.mode = OpenEXR.ONE_LEVEL
    return t


def write(path, header, channels):
    with OpenEXR.File(header, channels) as f:
        f.write(path)
    print("wrote", path)


def main(out):
    os.makedirs(out, exist_ok=True)
    r, g, b = gradient(np.float16)
    rf, gf, bf = gradient(np.float32)

    codecs = [n for n in dir(OpenEXR) if n.endswith("_COMPRESSION")]
    for name in sorted(codecs):
        tag = name[: -len("_COMPRESSION")].lower()
        header = {"compression": getattr(OpenEXR, name), "type": OpenEXR.scanlineimage}
        try:
            write(
                os.path.join(out, f"codec_{tag}.exr"),
                header,
                {"R": r, "G": g, "B": b, "Z": rf},
            )
        except Exception as e:  # e.g. a codec that cannot store float
            print("skipped", tag, e)

    # One part, many AOV layers, the way renderers write them.
    layers = {"R": r, "G": g, "B": b, "A": np.ones_like(r)}
    for layer, scale in (("diffuse", 0.5), ("specular", 2.0), ("emission", 8.0)):
        layers[f"{layer}.R"] = r * np.float16(scale)
        layers[f"{layer}.G"] = g * np.float16(scale)
        layers[f"{layer}.B"] = b * np.float16(scale)
    layers["depth.Z"] = rf * 100.0
    layers["crypto00.R"] = gf
    write(
        os.path.join(out, "multilayer_dwaa.exr"),
        {"compression": OpenEXR.DWAA_COMPRESSION, "type": OpenEXR.scanlineimage},
        layers,
    )

    # Multi-part with mixed codecs and storage.
    parts = [
        OpenEXR.Part(
            {"compression": OpenEXR.DWAB_COMPRESSION, "type": OpenEXR.scanlineimage},
            {"R": r, "G": g, "B": b},
            name="beauty",
        ),
        OpenEXR.Part(
            {
                "compression": OpenEXR.PIZ_COMPRESSION,
                "type": OpenEXR.tiledimage,
                "tiles": tiles(64),
            },
            {"Z": rf * 10.0},
            name="depth",
        ),
        OpenEXR.Part(
            {"compression": OpenEXR.ZIP_COMPRESSION, "type": OpenEXR.scanlineimage},
            {"N.X": rf, "N.Y": gf, "N.Z": bf},
            name="normals",
        ),
    ]
    with OpenEXR.File(parts) as f:
        f.write(os.path.join(out, "multipart_mixed.exr"))
    print("wrote", os.path.join(out, "multipart_mixed.exr"))

    # Tiled DWAB with partial edge tiles (320x200 is not a multiple of 48).
    write(
        os.path.join(out, "tiled_dwab.exr"),
        {
            "compression": OpenEXR.DWAB_COMPRESSION,
            "type": OpenEXR.tiledimage,
            "tiles": tiles(48),
        },
        {"R": r, "G": g, "B": b},
    )

    # Luminance/chroma with 2x2 subsampled chroma.
    write(
        os.path.join(out, "subsampled_yc.exr"),
        {"compression": OpenEXR.ZIP_COMPRESSION, "type": OpenEXR.scanlineimage},
        {
            "Y": OpenEXR.Channel(g),
            "RY": OpenEXR.Channel(r[::2, ::2].copy(), 2, 2),
            "BY": OpenEXR.Channel(b[::2, ::2].copy(), 2, 2),
        },
    )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "generated")
