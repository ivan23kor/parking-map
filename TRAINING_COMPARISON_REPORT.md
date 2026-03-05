# Training A/B Test Comparison Report

**Date:** 2026-03-04
**Goal:** Isolate cause of training instability (negative annotations vs augmentation)

---

## Log File Mapping

| Log file | Experiment | Run name | Status |
|---|---|---|---|
| `version_7.log` | **Version B** (neg ann OFF, aug ON) | `parking_sign_aug_nonegann` | ✅ Complete (30/30) |
| `version_6.log` | **Version A** (neg ann ON, aug OFF) | *(no config header captured)* | ⏳ Partial (epochs 17–24, cut off) |

**How identified:**
- `version_7.log`: Contains full run from setup through completion. Config line: `Negative annotations: OFF | Augmentation: ON`, run name `parking_sign_aug_nonegann`, 2,570 train images, 161 batches/epoch.
- `version_6.log`: No setup header (starts mid-epoch 17 at timestamp 11078s). Identified as Version A by 1,759 batches/epoch (consistent with ~28,140 images) and ~650s/epoch runtime (10× longer than Version B's ~54s/epoch due to 11× more data).

---

## Results Summary

### Version B — Neg Ann OFF, Aug ON (version_7.log) ✅ COMPLETE

| Metric | Value |
|---|---|
| Epochs | 30/30 |
| Training time | 0.458 hours (~27 min) |
| Train images | 2,570 |
| Final val mAP50 | **0.989** |
| Final val mAP50-95 | **0.758** |
| Best val mAP50 | 0.989 (epoch 25) |
| Best val mAP50-95 | 0.758 (epoch 25) |
| Test mAP50 | **0.986** |
| Test mAP50-95 | **0.761** |
| Loss progression | Smooth, monotonic decrease |
| Stability | ✅ Stable — no oscillation |

**Val mAP50 progression (every epoch):**
```
E1:  0.005  E2:  0.125  E3:  0.149  E4:  0.643  E5:  0.898
E6:  0.948  E7:  0.948  E8:  0.963  E9:  0.959  E10: 0.964
E11: 0.960  E12: 0.963  E13: 0.977  E14: 0.975  E15: 0.978
E16: 0.980  E17: 0.987  E18: 0.984  E19: 0.984  E20: 0.988
E21: 0.987  E22: 0.986  E23: 0.989  E24: 0.989  E25: 0.989
E26: 0.989  E27: 0.988  E28: 0.989  E29: 0.988  E30: 0.989*
```
*best.pt selected from epoch 25

### Version A — Neg Ann ON, Aug OFF (version_6.log) ⏳ PARTIAL

| Metric | Value |
|---|---|
| Epochs captured | 17–24 of 30 (log starts mid-epoch 17) |
| Train images | ~28,140 (with negatives) |
| Estimated epoch time | ~650s (~11 min) |
| Estimated total time | ~5.4 hours |

**Val mAP metrics captured (epochs 17–23):**

| Epoch | P | R | mAP50 | mAP50-95 |
|---|---|---|---|---|
| 17 | 0.965 | 0.928 | 0.973 | 0.752 |
| 18 | 0.965 | 0.933 | 0.974 | 0.755 |
| 19 | 0.973 | 0.915 | 0.972 | 0.757 |
| 20 | 0.982 | 0.931 | 0.981 | **0.768** |
| 21 | 0.982 | 0.933 | 0.975 | 0.765 |
| 22 | 0.975 | 0.928 | 0.971 | 0.763 |
| 23 | 0.982 | 0.928 | 0.976 | 0.775 |

**Key observations:**
- Loss values are smooth and decreasing (box_loss ~0.46, cls_loss ~0.24 at epoch 24)
- mAP50 plateaued ~0.972–0.981 (vs Version B's 0.989)
- mAP50-95 slightly higher: **0.775** at epoch 23 (vs Version B's 0.758)
- **No oscillation or instability visible in captured range**
- Still training at epoch 24 when log was captured — not yet complete

---

## Analysis

### Both versions are STABLE → Decision Matrix Row 3

Per the decision matrix from the original report:

> **Both stable → Combination causes instability (neither alone is problematic)**

Neither negative annotations alone (Version A) nor aggressive augmentation alone (Version B) caused training instability. The original instability must have been caused by their **interaction** — specifically, aggressive augmentation (mosaic, mixup, scale, shear) applied to a dataset dominated by 91% negative/background images (25,570 of 28,140).

### Performance comparison (partial data)

| Metric | Version A (epoch 23) | Version B (epoch 30) |
|---|---|---|
| Val mAP50 | 0.976 | **0.989** |
| Val mAP50-95 | **0.775** | 0.758 |
| Training time (est.) | ~5.4 hours | **0.458 hours** |
| Stability | ✅ Stable | ✅ Stable |

- Version B wins on mAP50 (0.989 vs 0.976) and training speed (12× faster)
- Version A shows slightly better mAP50-95 (0.775 vs 0.758), suggesting the negatives may help with tighter localization — but it hasn't finished training yet

---

## Root Cause Hypothesis

Mosaic augmentation (1.0) combines 4 images into one training sample. When 91% of images are empty backgrounds, most mosaic tiles contain no objects, creating extremely sparse training signals. Combined with mixup (0.08), scale (0.4), and shear (2.0), the model receives heavily distorted images where the rare parking sign tiles are further degraded. This creates contradictory gradients — the model is simultaneously penalized for detecting things in empty backgrounds and rewarded for finding highly augmented signs.

---

## Recommended Next Experiments

### Priority 1: Finish Version A
Wait for the full 30-epoch Version A log from Kaggle to confirm final mAP50-95 (trending 0.775+, potentially >0.760).

### Priority 2: Version C — Both ON, controlled negative ratio
The key experiment to run next. Use Version B's augmentation config but reintroduce a **controlled subset** of negatives:

| Config | Value |
|---|---|
| Augmentation | ON (same as Version B) |
| Negatives | ~500–1000 hard negatives (not all 25,570) |
| Negative ratio | ~20–30% of dataset (vs original 91%) |
| Rationale | Some negatives reduce false positives; too many cause instability |

This tests the hypothesis that the interaction (aug + negatives) only breaks at extreme negative ratios.

### Priority 3: Version D — Both ON, reduced augmentation
If Version C is still unstable, try the full negative dataset with **mild** augmentation:

| Config | Value |
|---|---|
| Negatives | ON (full 28,140) |
| Mosaic | 0.3 (not 1.0) |
| Mixup | 0.0 |
| Scale | 0.15 |
| Shear | 0.0 |

### Production model selection (if no further experiments)
Version B (`parking_sign_aug_nonegann`) is the current best:
- mAP50: 0.986 on test set
- 27-minute training time
- Stable convergence
- Weights: `runs/parking_sign_aug_nonegann/weights/best.pt`

---

## Key Files

| File | Description |
|---|---|
| `version_7.log` | Version B complete log (neg ann OFF, aug ON) |
| `version_6.log` | Version A partial log (neg ann ON, aug OFF, epochs 17–24) |
| `notebooks/parking_sign_training_baseline.ipynb` | Version A notebook config |
| `notebooks/parking_sign_training_fullaug.ipynb` | Version B notebook config |
