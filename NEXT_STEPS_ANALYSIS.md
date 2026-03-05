# Training Next Steps — Deep Analysis

**Date:** 2026-03-04
**Based on:** Version B completed (mAP50=0.989), Version A partial (mAP50~0.976)

---

## 1. Extra Instrumentation Needed in Training Script

The current notebook logs **only epoch-level YOLO defaults** (box/cls/dfl loss, P, R, mAP50, mAP50-95). Ultralytics auto-generates confusion matrix and results.png, but we're missing several critical diagnostics:

### Must-add (before next experiment)

| What | Why | How |
|---|---|---|
| **Per-size-bucket mAP** | Know if small signs are the bottleneck | After training: `model.val(...)` then parse `results.box.ap_class_index` by bbox area buckets (small <32², medium <96², large) |
| **Confidence distribution histogram** | Understand gap between TP and FP confidence | `results.boxes.conf` → histogram, log median TP conf vs median FP conf |
| **False positive categories** | What objects get confused for signs? | Save top-20 highest-confidence FP crops with their confidence + image context |
| **False negative examples** | What signs are being missed? | Save all FN images (ground-truth signs with IoU<0.5 to any prediction) |
| **Per-image inference on test set** | Full prediction dump for offline analysis | `model.predict(test_images, save_txt=True, save_conf=True)` → gives per-image predictions |

### Nice-to-have

| What | Why |
|---|---|
| **Training loss per-batch (not just epoch avg)** | Detect within-epoch instability that epoch averages mask |
| **Gradient norm tracking** | Early warning for training divergence |
| **Val loss at multiple confidence thresholds** | Understand optimal operating point |

### Implementation snippet (add to notebook cell 7, after `best_model.val()`):

```python
# === Additional diagnostics ===
import numpy as np

# 1. Detailed per-image predictions on test set
print("\nRunning detailed test set analysis...")
test_preds = best_model.predict(
    source=str(FILTERED_PATH / "test" / "images"),
    conf=0.01,  # Low threshold to capture all predictions
    save_txt=True,
    save_conf=True,
    project=str(OUTPUT_PATH / "runs"),
    name=f"{RUN_NAME}_test_predictions",
    exist_ok=True,
)

# 2. Confidence distribution
all_confs = []
for r in test_preds:
    if r.boxes is not None and len(r.boxes):
        all_confs.extend(r.boxes.conf.cpu().numpy().tolist())

if all_confs:
    confs = np.array(all_confs)
    print(f"\nConfidence distribution (test set, conf>0.01):")
    print(f"  N predictions: {len(confs)}")
    print(f"  Mean: {confs.mean():.3f}, Median: {np.median(confs):.3f}")
    print(f"  <0.25: {(confs < 0.25).sum()}, 0.25-0.5: {((confs >= 0.25) & (confs < 0.5)).sum()}")
    print(f"  0.5-0.75: {((confs >= 0.5) & (confs < 0.75)).sum()}, >0.75: {(confs >= 0.75).sum()}")

# 3. Save confusion matrix data (Ultralytics does this automatically but let's also log raw numbers)
print(f"\nDiagnostic outputs saved to: {OUTPUT_PATH / 'runs' / f'{RUN_NAME}_test_predictions'}")
```

---

## 2. Next 2–3 Parallel Experiments

Run these simultaneously on Kaggle (each ~30 min on 2×T4):

### Experiment C: Augmentation ON + Controlled Negatives (20% ratio)
**Goal:** Test if negatives + aug work when negative ratio is reasonable

```python
# Keep ~500 random negatives (20% of 2570 positives)
# Filter: keep all positive images + random 500 of 25,570 negatives
NEGATIVE_KEEP_RATIO = 0.02  # 500/25570
```

- Aug config: same as Version B (exp7_stabilized_v3)
- Expected train images: ~3,070 (2,570 + 500 negatives)
- **Tests:** Does a small negative dose reduce FP without causing instability?

### Experiment D: Larger Model (YOLO11l instead of YOLO11m)
**Goal:** Test if model capacity is a bottleneck

```python
model = YOLO("yolo11l.pt")  # Large instead of Medium
# Same dataset as Version B (no negatives, aug ON)
# Same aug config
```

- YOLO11m: 20M params, 68 GFLOPs
- YOLO11l: 25M params, 87 GFLOPs (~25% more capacity)
- **Tests:** Is mAP50-95 capped by model capacity or data?

### Experiment E: Higher Resolution (imgsz=1024)
**Goal:** Test if small signs benefit from higher input resolution

```python
TRAIN_PARAMS["imgsz"] = 1024  # Up from 640
TRAIN_PARAMS["batch"] = 8     # Reduce batch for GPU memory
```

- Same dataset as Version B, same model (yolo11m)
- **Tests:** Do we gain on small/distant signs? (resolution is cheap compute-wise on Kaggle's T4s)

---

## 3. Highest ROI Steps to Improve Precision & Recall

Ranked by expected impact per effort:

### Tier 1 — High ROI (do first)

| Step | Expected Impact | Effort | Why |
|---|---|---|---|
| **More diverse training images** | ⬆⬆⬆ | Medium | Current dataset: ~2,570 positives from only 2 sources (Roboflow parking-sign-coco + SF parking signs). Both are US-centric, mostly daytime, clear weather. Adding images from different cities, weather, lighting, camera angles would have the biggest single impact. |
| **Higher input resolution (1024)** | ⬆⬆ | Low | Parking signs in Street View are often small (20-50px in 640px image). Going to 1024 or even 1280 directly improves detection of distant/small signs with minimal code change. |
| **Controlled hard negatives** | ⬆⬆ | Low | The 25K negatives are random background crops. Instead, mine **hard negatives**: run the current model on Street View images, collect high-confidence false positives (business signs, speed limit signs, etc.), and add those specifically. 200–500 curated hard negatives > 25,000 random ones. |

### Tier 2 — Medium ROI

| Step | Expected Impact | Effort | Why |
|---|---|---|---|
| **Test-time augmentation (TTA)** | ⬆ | Very Low | `model.predict(augment=True)` — free precision boost at the cost of 3× inference time. Worth it for batch processing. |
| **Annotation quality audit** | ⬆⬆ | Medium | Unknown how many labels are noisy (wrong bbox, missed signs, mislabeled). Even 5% label noise caps mAP50-95. Review 200 random train samples. |
| **Multi-class detection** | ⬆ | Medium | Currently single-class "parking_sign". If the model confuses parking signs with speed limit/street/business signs, adding those as separate classes would dramatically reduce FP. |
| **Larger model (YOLO11l/x)** | ⬆ | Low | Marginal gains expected — mAP50 is already 0.989. Might help mAP50-95 (tighter boxes). |

### Tier 3 — Lower ROI (diminishing returns)

| Step | Expected Impact | Effort | Why |
|---|---|---|---|
| **More augmentation experiments** | ↔ | Low | We've already found a stable aug config. Marginal gains from tuning HSV/rotation params. |
| **Different architecture (RT-DETR, etc.)** | ↔ | High | YOLO11 is already near SOTA for this task. Architecture change unlikely to move the needle vs data improvements. |
| **Feature engineering** | ↔ | High | YOLO is end-to-end; manual feature engineering doesn't apply. |
| **Bigger dataset of same distribution** | ↔ | Medium | More of the same US parking signs has diminishing returns. Diversity matters more than volume. |

### The #1 bottleneck is almost certainly **data diversity**, not model or training config.

The current 2,570 positive images come from 2 similar-distribution US sources. The model has effectively memorized this distribution — mAP50=0.989 means it detects virtually every sign in test images *that look like training images*. The real-world gap is images that look different: night, rain, snow, occlusion, non-US sign styles, unusual camera angles.

---

## 4. Why Current Precision/Recall Are at This Level

### What we know performs well
- **Standard US parking signs in daylight** — the entire training set is this scenario
- **Signs at medium distance** (occupying 5–20% of frame) — well-represented in data
- **Clear weather, good lighting** — no adverse conditions in dataset
- **Front-facing camera angle** — standard Street View perspective

### What likely performs poorly (based on dataset composition)
- **Small/distant signs** — YOLO at 640px has ~20px effective resolution for objects <3% of frame. Signs at 50+ meters from the Street View car are likely missed. This is the main recall bottleneck.
- **Occluded signs** — partially hidden by trees, other signs, or vehicles. No occlusion augmentation in the pipeline.
- **Night/low light** — zero nighttime images in training data (both sources are daytime).
- **Non-standard signs** — regulatory signs in other countries, temporary/handmade parking signs, signs with different color schemes.
- **False positives on similar objects** — business signs, "FOR SALE" signs, speed limit signs, "NO PARKING" signs that aren't parking-regulation signs. The model has a single class and no explicit negative examples of these.
- **Signs at extreme angles** — The training data from Street View is mostly front-facing, but the production pipeline uses heading offsets of ±45°+ which creates perspective distortion.

### Why mAP50 is high but mAP50-95 is lower (0.989 vs 0.758)
mAP50-95 averages across IoU thresholds from 0.50 to 0.95. The gap means:
- The model **finds** signs reliably (high recall at IoU=0.5)
- But predicted bounding boxes are **imprecise** — off by ~10–20% from ground truth
- This is typical for small objects and can be improved by: higher resolution, better annotation quality, or anchor-free heads (YOLO11 already uses these)

---

## 5. Metrics Explainer & Current Numbers

### Metrics We Have

| Metric | Version B (test) | Version A (ep23 val) | What It Means |
|---|---|---|---|
| **Precision (P)** | 0.980 | 0.982 | Of all predicted signs, 98% are actually signs. Very few false positives. |
| **Recall (R)** | 0.962 | 0.928 | Of all actual signs, 96% are detected. ~4% of signs are missed. |
| **mAP50** | 0.986 | 0.976 | Mean Average Precision at IoU≥0.50. Area under the Precision-Recall curve when a detection counts as correct if it overlaps ≥50% with ground truth. **This is the primary detection quality metric.** 0.986 = excellent. |
| **mAP50-95** | 0.761 | 0.775 | Average of mAP at IoU thresholds 0.50, 0.55, ..., 0.95. Penalizes imprecise bounding boxes. 0.76 = good but room for improvement in box tightness. |
| **box_loss** | ~0.49 (final) | ~0.46 (ep24) | CIoU loss for bounding box regression. Lower = tighter boxes. |
| **cls_loss** | ~0.29 (final) | ~0.24 (ep24) | Classification loss. Lower = more confident correct predictions. Version A lower because more negative training signal. |
| **dfl_loss** | ~0.52 (final) | ~0.53 (ep24) | Distribution Focal Loss for box refinement. Lower = better. |

### Metrics We DON'T Have (but should)

| Metric | What It Is | Why We Want It |
|---|---|---|
| **ROC-AUC** | Area under ROC curve (TPR vs FPR across confidence thresholds). For object detection, this is per-image (did we correctly identify if an image contains a sign?). | Not directly applicable to object detection — mAP is the standard equivalent. YOLO doesn't output ROC-AUC by default. We'd compute it only if doing image-level classification (sign present yes/no). |
| **F1 score** | Harmonic mean of precision and recall at optimal confidence threshold. | Ultralytics computes this and saves `F1_curve.png` in the run directory. We just aren't extracting the number from logs. |
| **AP per size bucket** | mAP broken down by object size (small/medium/large per COCO definitions). | Would tell us exactly where small-sign detection breaks down. Requires post-processing the val results. |
| **FP breakdown** | What categories of objects cause false positives. | Requires manual review or a multi-class dataset. |
| **Inference speed** | ms/image in production conditions (CPU vs GPU, batch size). | Logged: 6.1ms/image on T4 GPU (Version B). For production on CPU, expect 50–200ms. |

### How to interpret the numbers for production

At **conf=0.15** (current backend default):
- Very high recall (~96%+), but lower precision — you'll see more false positives
- Good for "find all possible signs" scanning mode

At **conf=0.50** (typical production threshold):
- Based on the PR curve shape (mAP50=0.986), expect P≈0.99, R≈0.95
- Best balance for production use

At **conf=0.75**:
- Very high precision (>0.99), but recall drops to ~0.90
- Good for "only show me confident detections"

---

## Summary: What to Do Next

1. **Add instrumentation** (FP/FN image dumps, confidence histogram, per-size mAP) to the notebook — 30 min of work
2. **Run Experiments C, D, E in parallel** on Kaggle — 3 runs × 30 min each
3. **Collect hard negatives** from production: run the current model on 1000 Street View panoramas, save all high-confidence detections, manually label FPs → add to training set
4. **Try imgsz=1024** for the biggest likely single improvement (small sign detection)
5. **Long-term: diversify the dataset** with images from different cities, weather, lighting conditions
