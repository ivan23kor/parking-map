# YOLO CPU Optimization Report

## Context
We profiled the YOLO parking sign detection pipeline running on CPU to identify bottlenecks and test hypotheses for accelerating inference.

## Profile Baseline
Our initial profiling revealed:
- **Hardware Bottleneck:** The system lacks CUDA, so PyTorch runs exclusively on CPU.
- **Inference Time Dominates:** `model.predict()` consumed ~90% of the request duration (~400ms per image at default 640x640).
- **Sequential Overhead:** `/detect-panorama` sequentially queries YOLO twice, leading to ~800ms of YOLO inference before depth estimation even begins.
- **Negligible Overhead Elsewhere:** Pre/post-processing (<10ms) and network image fetching (~35ms per slice) are negligible compared to the forward pass.

## Hypotheses & Test Results

### 1. Input Size Optimization (`imgsz=512`)
**Hypothesis:** The model was trained at 512x512 but ultralytics defaults to inferring at 640x640, performing unnecessary FLOPs. Forcing `imgsz=512` during prediction will speed up inference.
**Result: SUCCESS**
By explicitly passing `imgsz=512` to `model.predict()`, we observed an immediate **~30% reduction in inference time**.
- **640x640 image:** dropped from **~416ms** to **~292ms**.
- **1280x960 image:** dropped from **~350ms** to **~211ms**.

*This optimization has been permanently applied to all backend endpoints (`/detect`, `/detect-file`, `/detect-panorama`, `/detect-debug`).*

### 2. Batch Inference for Panorama
**Hypothesis:** Passing both panorama slices as a batch (`model.predict([img1, img2])`) instead of running them sequentially inside a `for` loop will improve throughput via vectorization.
**Result: FAILED / NO IMPACT**
A standalone CPU benchmark passing a 2-image batch vs two sequential 1-image predict calls yielded identical results:
- Sequential (2 images): **602.9ms (301.4ms per image)**
- Batch (2 images): **612.9ms (306.5ms per image)**

**Why:** PyTorch's default CPU backend already parallelizes operations aggressively across available CPU cores. When processing a single image, it saturates the threads. Batching merely increases the memory footprint and adds minor dispatch overhead without increasing throughput on this hardware.

## Conclusion & Next Steps
We successfully reduced the YOLO CPU inference time by **~30%** simply by explicitly matching the inference resolution (`imgsz=512`) to the model's training resolution. This cuts `/detect-panorama` total time by ~200-250ms.

If further CPU acceleration is required in the future, the model should be exported to Intel's OpenVINO format (`yolo export model=best.pt format=openvino`), which routinely provides an additional 2x-3x speedup on CPU hardware over standard PyTorch.