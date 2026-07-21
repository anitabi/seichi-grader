#!/usr/bin/env python3
"""Export a DINOv2/DINOv3 scene encoder to int8 ONNX for in-browser matching.

The default is DINOv3 ViT-S/16. It produces models/scene-embed-int8.onnx
(~21 MiB): 224x224 RGB in, 384-d CLS embedding out. Weights download from Hugging Face; set
HF_ENDPOINT=https://hf-mirror.com if huggingface.co is unreachable.
"""
import argparse
from pathlib import Path

import timm
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--variant", choices=("v2", "v3"), default="v3")
parser.add_argument("--prefix", default="scene-embed", help="filename prefix under models/")
args = parser.parse_args()

FP32 = ROOT / "models" / f"{args.prefix}-fp32.onnx"  # intermediate, not committed
INT8 = ROOT / "models" / f"{args.prefix}-int8.onnx"
MODEL_NAME = {
    "v2": "vit_small_patch14_dinov2.lvd142m",
    "v3": "vit_small_patch16_dinov3.lvd1689m",
}[args.variant]

model = timm.create_model(MODEL_NAME, pretrained=True, num_classes=0, img_size=224)
model.eval()

with torch.no_grad():
    torch.onnx.export(
        model,
        torch.zeros(1, 3, 224, 224),
        str(FP32),
        input_names=["image"],
        output_names=["embedding"],
        opset_version=17,
        # DINOv3's RoPE attention needs the newer exporter; DINOv2 retains the
        # legacy path so its output stays byte-for-byte compatible with the app.
        dynamo=args.variant == "v3",
    )

# 只量化 MatMul：onnxruntime-web 的 WASM EP 没有 ConvInteger 实现，
# patch 卷积保持 fp32（约 0.9MB，权重大头在注意力/MLP 的 MatMul 里）
quantize_dynamic(str(FP32), str(INT8), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"])
print(f"Wrote {INT8} ({INT8.stat().st_size / 1048576:.1f} MiB)")
