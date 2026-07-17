#!/usr/bin/env python3
"""Export DINOv2 ViT-S/14 to int8 ONNX for in-browser scene matching (找最像的实景).

Produces models/scene-embed-int8.onnx (~21 MiB): 224x224 RGB in, 384-d CLS
embedding out. Weights download from Hugging Face; set
HF_ENDPOINT=https://hf-mirror.com if huggingface.co is unreachable.
"""
from pathlib import Path

import timm
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic

ROOT = Path(__file__).resolve().parents[1]
FP32 = ROOT / "models/scene-embed-fp32.onnx"  # intermediate, not committed
INT8 = ROOT / "models/scene-embed-int8.onnx"

model = timm.create_model(
    "vit_small_patch14_dinov2.lvd142m", pretrained=True, num_classes=0, img_size=224
)
model.eval()

with torch.no_grad():
    torch.onnx.export(
        model,
        torch.zeros(1, 3, 224, 224),
        str(FP32),
        input_names=["image"],
        output_names=["embedding"],
        opset_version=17,
        dynamo=False,
    )

# 只量化 MatMul：onnxruntime-web 的 WASM EP 没有 ConvInteger 实现，
# patch 卷积保持 fp32（约 0.9MB，权重大头在注意力/MLP 的 MatMul 里）
quantize_dynamic(str(FP32), str(INT8), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"])
print(f"Wrote {INT8} ({INT8.stat().st_size / 1048576:.1f} MiB)")
