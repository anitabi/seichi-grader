#!/usr/bin/env python3
"""Finish memory-heavy SigLIP2 and C-RADIO QA runs one image at a time.

This resumes the partial report produced by compare-scene-models.py.  A batch
size of one keeps these 400M-parameter models within Apple unified memory.
"""

from __future__ import annotations

import json
import importlib.util
from pathlib import Path

import torch
import torch.nn.functional as F
from torchvision.transforms.functional import pil_to_tensor
from transformers import AutoModel, AutoProcessor

_SPEC = importlib.util.spec_from_file_location("scene_compare", Path(__file__).with_name("compare-scene-models.py"))
_COMPARE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_COMPARE)
ANIME, DEVICE, OUTPUT, PHOTO = _COMPARE.ANIME, _COMPARE.DEVICE, _COMPARE.OUTPUT, _COMPARE.PHOTO
evaluate, images, numbered_images, truth = _COMPARE.evaluate, _COMPARE.images, _COMPARE.numbered_images, _COMPARE.truth


PARTIAL = OUTPUT.with_name("model-comparison.partial.json")


def save(report):
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    PARTIAL.write_text(text)
    OUTPUT.write_text(text)


def clear_mps():
    if DEVICE == "mps":
        torch.mps.empty_cache()


def main():
    report = json.loads(PARTIAL.read_text())
    existing = {model["model"] for model in report["models"]}
    anime, photo = numbered_images(ANIME), numbered_images(PHOTO)
    pairs, _ = truth(anime, photo)
    query_ids, candidate_ids = sorted(pairs), sorted(photo)
    query_paths = [anime[number] for number in query_ids]
    candidate_paths = [photo[number] for number in candidate_ids]

    siglip_label = "Google SigLIP2 So400m/16@384px"
    if siglip_label not in existing:
        print(f"Loading {siglip_label}", flush=True)
        name = "google/siglip2-so400m-patch16-384"
        processor = AutoProcessor.from_pretrained(name)
        model = AutoModel.from_pretrained(name).to(DEVICE).eval()

        @torch.inference_mode()
        def encode(paths):
            vectors = []
            for image in images(paths):
                inputs = processor(images=image, return_tensors="pt").to(DEVICE)
                vector = model.get_image_features(**inputs)
                # Transformers 5 returns a vision-model output object here;
                # earlier releases returned the pooled tensor directly.
                vector = getattr(vector, "pooler_output", vector)
                vectors.append(F.normalize(vector.float(), dim=-1).cpu())
                del inputs, vector
                clear_mps()
            return torch.cat(vectors)

        result = evaluate(siglip_label, query_ids, candidate_ids, encode(query_paths), encode(candidate_paths), pairs)
        report["models"].append(result)
        save(report)
        del model
        clear_mps()

    radio_label = "NVIDIA C-RADIOv4-SO400M"
    if radio_label not in {model["model"] for model in report["models"]}:
        print(f"Loading {radio_label}", flush=True)
        radio = torch.hub.load("NVlabs/RADIO", "radio_model", version="c-radio_v4-so400m", progress=True, skip_validation=True).to(DEVICE).eval()

        @torch.inference_mode()
        def encode(paths):
            vectors = []
            for image in images(paths):
                batch = pil_to_tensor(image.resize((384, 384))).float().div_(255).unsqueeze(0).to(DEVICE)
                summary, _ = radio(batch)
                vectors.append(F.normalize(summary.float(), dim=-1).cpu())
                del batch, summary
                clear_mps()
            return torch.cat(vectors)

        result = evaluate(radio_label, query_ids, candidate_ids, encode(query_paths), encode(candidate_paths), pairs)
        report["models"].append(result)
        save(report)

    for model in report["models"]:
        print(f"{model['model']}: Top-1 {model['top1']}/{model['count']} ({model['top1_rate']:.1%})")


if __name__ == "__main__":
    main()
