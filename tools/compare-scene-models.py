#!/usr/bin/env python3
"""Compare CLIP and DINOv2 global-image retrieval on the forum QA set.

The ground truth comes from results-full.json.  It deliberately skips records
whose referenced image is absent, so a bad filename is not counted as a model
mistake.  Run with .venv-convert/bin/python.
"""

from __future__ import annotations

import json
from pathlib import Path

import open_clip
import timm
import torch
import torch.nn.functional as F
from PIL import Image
from torchvision.transforms.functional import pil_to_tensor
from transformers import AutoModel, AutoProcessor


ROOT = Path(__file__).resolve().parents[1]
QA = ROOT / "qa" / "forum-match-20260717"
ANIME = QA / "动画截图"
PHOTO = QA / "实拍图"
OUTPUT = QA / "model-comparison.json"
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"


def numbered_images(folder: Path) -> dict[int, Path]:
    return {int(path.name.split("_", 1)[0]): path for path in folder.glob("*.[Jj][Pp][Gg]")}


def truth(anime: dict[int, Path], photo: dict[int, Path]) -> tuple[dict[int, int], list[dict]]:
    data = json.loads((QA / "results-full.json").read_text())
    pairs: dict[int, int] = {}
    skipped = []
    for item in data["results"]:
        query, expected = item["query"], item["expected"]
        if query in pairs:  # results-full.json has an extra duplicate probe
            continue
        if query not in anime or expected not in photo:
            skipped.append({"query": query, "expected": expected, "reason": "referenced file is absent"})
            continue
        pairs[query] = expected
    return pairs, skipped


def images(paths: list[Path]):
    for path in paths:
        with Image.open(path) as image:
            yield image.convert("RGB")


def release(model):
    del model
    if DEVICE == "mps":
        torch.mps.empty_cache()


@torch.inference_mode()
def encode(paths: list[Path], preprocess, model, encoder) -> torch.Tensor:
    batches = []
    for start in range(0, len(paths), 16):
        batch = torch.stack([preprocess(image) for image in images(paths[start : start + 16])]).to(DEVICE)
        vectors = encoder(model, batch)
        batches.append(F.normalize(vectors.float(), dim=-1).cpu())
    return torch.cat(batches)


def evaluate(name: str, query_ids, candidate_ids, query_vectors, candidate_vectors, pairs):
    scores = query_vectors @ candidate_vectors.T
    output = []
    for row, query_id in enumerate(query_ids):
        ranking = torch.argsort(scores[row], descending=True).tolist()
        expected = pairs[query_id]
        expected_index = candidate_ids.index(expected)
        rank = ranking.index(expected_index) + 1
        output.append({
            "query": query_id,
            "expected": expected,
            "rank": rank,
            "top5": [{"number": candidate_ids[index], "similarity": round(float(scores[row, index]), 6)} for index in ranking[:5]],
        })
    count = len(output)
    return {
        "model": name,
        "top1": sum(x["rank"] == 1 for x in output),
        "top3": sum(x["rank"] <= 3 for x in output),
        "top5": sum(x["rank"] <= 5 for x in output),
        "count": count,
        "top1_rate": round(sum(x["rank"] == 1 for x in output) / count, 4),
        "top3_rate": round(sum(x["rank"] <= 3 for x in output) / count, 4),
        "top5_rate": round(sum(x["rank"] <= 5 for x in output) / count, 4),
        "results": output,
    }


def main():
    anime, photo = numbered_images(ANIME), numbered_images(PHOTO)
    pairs, skipped = truth(anime, photo)
    query_ids, candidate_ids = sorted(pairs), sorted(photo)
    query_paths = [anime[number] for number in query_ids]
    candidate_paths = [photo[number] for number in candidate_ids]

    def checkpoint(models):
        partial = {
            "dataset": {"queries_scored": len(pairs), "candidate_photos": len(photo), "skipped_truth_records": skipped},
            "device": DEVICE,
            "models": models,
        }
        OUTPUT.with_name("model-comparison.partial.json").write_text(json.dumps(partial, ensure_ascii=False, indent=2) + "\n")

    clip_results = []
    # B/32 is the compact original CLIP; L/14 is its stronger, higher-resolution
    # counterpart.  Testing both prevents a model-size choice from masquerading
    # as a CLIP-vs-DINO conclusion.
    for architecture, pretrained, label in [
        ("ViT-B-32", "openai", "OpenAI CLIP ViT-B/32"),
        ("ViT-L-14", "openai", "OpenAI CLIP ViT-L/14"),
        ("ViT-L-14-336", "openai", "OpenAI CLIP ViT-L/14@336px"),
        ("ViT-L-14", "datacomp_xl_s13b_b90k", "OpenCLIP ViT-L/14 DataComp-1B"),
        ("EVA02-L-14-336", "merged2b_s6b_b61k", "EVA-CLIP EVA02-L/14@336px"),
    ]:
        print(f"Loading and evaluating {label}", flush=True)
        clip, _, clip_preprocess = open_clip.create_model_and_transforms(architecture, pretrained=pretrained, device=DEVICE)
        clip.eval()
        clip_results.append(evaluate(
            label, query_ids, candidate_ids,
            encode(query_paths, clip_preprocess, clip, lambda m, b: m.encode_image(b)),
            encode(candidate_paths, clip_preprocess, clip, lambda m, b: m.encode_image(b)), pairs,
        ))
        checkpoint(clip_results)
        release(clip)

    print("Loading and evaluating Meta DINOv2 ViT-S/14", flush=True)
    dino = timm.create_model("vit_small_patch14_dinov2.lvd142m", pretrained=True, num_classes=0).to(DEVICE).eval()
    dino_preprocess = timm.data.create_transform(**timm.data.resolve_model_data_config(dino), is_training=False)
    dino_result = evaluate(
        "Meta DINOv2 ViT-S/14", query_ids, candidate_ids,
        encode(query_paths, dino_preprocess, dino, lambda m, b: m(b)),
        encode(candidate_paths, dino_preprocess, dino, lambda m, b: m(b)), pairs,
    )
    checkpoint([*clip_results, dino_result])
    release(dino)

    print("Loading and evaluating Meta DINOv3 ViT-S/16", flush=True)
    dino3 = timm.create_model("vit_small_patch16_dinov3.lvd1689m", pretrained=True, num_classes=0).to(DEVICE).eval()
    dino3_preprocess = timm.data.create_transform(**timm.data.resolve_model_data_config(dino3), is_training=False)
    dino3_result = evaluate(
        "Meta DINOv3 ViT-S/16", query_ids, candidate_ids,
        encode(query_paths, dino3_preprocess, dino3, lambda m, b: m(b)),
        encode(candidate_paths, dino3_preprocess, dino3, lambda m, b: m(b)), pairs,
    )
    checkpoint([*clip_results, dino_result, dino3_result])
    release(dino3)

    print("Loading and evaluating Google SigLIP2 So400m/16@384px", flush=True)
    siglip_name = "google/siglip2-so400m-patch16-384"
    siglip_processor = AutoProcessor.from_pretrained(siglip_name)
    siglip = AutoModel.from_pretrained(siglip_name).to(DEVICE).eval()

    @torch.inference_mode()
    def siglip_encode(paths):
        vectors = []
        for start in range(0, len(paths), 8):
            batch_images = list(images(paths[start : start + 8]))
            inputs = siglip_processor(images=batch_images, return_tensors="pt").to(DEVICE)
            vectors.append(F.normalize(siglip.get_image_features(**inputs).float(), dim=-1).cpu())
        return torch.cat(vectors)

    siglip_result = evaluate(
        "Google SigLIP2 So400m/16@384px", query_ids, candidate_ids,
        siglip_encode(query_paths), siglip_encode(candidate_paths), pairs,
    )
    checkpoint([*clip_results, dino_result, dino3_result, siglip_result])
    release(siglip)

    print("Loading and evaluating NVIDIA C-RADIOv4-SO400M", flush=True)
    radio = torch.hub.load("NVlabs/RADIO", "radio_model", version="c-radio_v4-so400m", progress=True, skip_validation=True).to(DEVICE).eval()

    @torch.inference_mode()
    def radio_encode(paths):
        vectors = []
        for start in range(0, len(paths), 8):
            tensors = [pil_to_tensor(image.resize((384, 384))).float().div_(255) for image in images(paths[start : start + 8])]
            batch = torch.stack(tensors).to(DEVICE)
            summary, _ = radio(batch)
            vectors.append(F.normalize(summary.float(), dim=-1).cpu())
        return torch.cat(vectors)

    radio_result = evaluate(
        "NVIDIA C-RADIOv4-SO400M", query_ids, candidate_ids,
        radio_encode(query_paths), radio_encode(candidate_paths), pairs,
    )
    checkpoint([*clip_results, dino_result, dino3_result, siglip_result, radio_result])
    release(radio)

    report = {
        "dataset": {"queries_scored": len(pairs), "candidate_photos": len(photo), "skipped_truth_records": skipped},
        "device": DEVICE,
        "models": [*clip_results, dino_result, dino3_result, siglip_result, radio_result],
    }
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    for result in report["models"]:
        print(f"{result['model']}: Top-1 {result['top1']}/{result['count']} ({result['top1_rate']:.1%}), "
              f"Top-3 {result['top3']}/{result['count']} ({result['top3_rate']:.1%}), "
              f"Top-5 {result['top5']}/{result['count']} ({result['top5_rate']:.1%})")
    print(f"Saved {OUTPUT}")


if __name__ == "__main__":
    main()
