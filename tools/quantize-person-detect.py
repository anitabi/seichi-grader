#!/usr/bin/env python3
"""Create an int8 candidate for the browser-side anime person detector.

The detector is a CNN, so use static (calibration-based) quantization rather
than the weight-only dynamic quantization used by the DINO scene encoder.
This creates a candidate only; validate it before replacing the production
model.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from onnxruntime.quantization import (
    CalibrationDataReader,
    QuantFormat,
    QuantType,
    quantize_static,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_IMAGES = [
    ROOT / "test-anime.png",
    ROOT / "test-anime-coast.jpg",
    ROOT / "test-anime-hills.jpg",
    ROOT / "test-izu-far.jpg",
    ROOT / "test-izu-multi.jpg",
    *sorted((ROOT / "work" / "bahamut").glob("*.jpg"))[:12],
]


def preprocess(path: Path, size: int = 1024) -> np.ndarray:
    """Match detect.js: left/top letterbox with 114-gray padding and /255."""
    image = Image.open(path).convert("RGB")
    width, height = image.size
    scale = size / max(width, height)
    valid_w, valid_h = round(width * scale), round(height * scale)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    canvas.paste(image.resize((valid_w, valid_h), Image.Resampling.BILINEAR), (0, 0))
    rgb = np.asarray(canvas, dtype=np.float32) / 255.0
    return np.ascontiguousarray(np.transpose(rgb, (2, 0, 1))[None])


class ImageReader(CalibrationDataReader):
    def __init__(self, input_name: str, paths: list[Path]):
        self.input_name = input_name
        self.paths = iter(paths)

    def get_next(self):
        try:
            return {self.input_name: preprocess(next(self.paths))}
        except StopIteration:
            return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=ROOT / "models/person-detect.onnx")
    parser.add_argument("--output", type=Path, default=ROOT / "models/person-detect-int8-test.onnx")
    args = parser.parse_args()

    usable = [path for path in DEFAULT_IMAGES if path.is_file()]
    if len(usable) < 4:
        raise SystemExit("Need at least four local calibration images.")

    # The source's only input is named "images". Keeping this explicit makes
    # an upstream model replacement fail loudly instead of producing bad data.
    reader = ImageReader("images", usable)
    quantize_static(
        str(args.input),
        str(args.output),
        reader,
        quant_format=QuantFormat.QOperator,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        per_channel=True,
        op_types_to_quantize=["Conv"],
    )
    print(f"Wrote {args.output} ({args.output.stat().st_size / 1048576:.1f} MiB) using {len(usable)} images")


if __name__ == "__main__":
    main()
