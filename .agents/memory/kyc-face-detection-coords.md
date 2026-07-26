---
name: KYC InsightFace coordinate space and normalisation
description: SCRFD detection and face cropping must share the same 640×640 buffer; different normalisation applies to detection vs. recognition models.
---

**Bug fixed:** Original code ran SCRFD detection on a 640×640 buffer but then cropped from the original (variable-size) buffer using 640×640 coordinates — producing crops at wrong locations.

**Rule:** `detectAndEmbed()` resizes the input to 640×640 using `fit: 'fill'` and stores this as `detBuffer`. Both the detection inference and the `cropFace()` call use `detBuffer`. The original `buffer` is never used after resizing.

**Detection model normalisation (SCRFD):** `(pixel − 127.5) / 128.0`  
**Recognition model normalisation (ArcFace):** `(pixel − 127.5) / 127.5`  
Do NOT swap these. Using `pixel / 255` for SCRFD was Bug 8 — it shifts the input distribution by ~50%.

**SCRFD output parsing (Bug 7 fix):** Two strategies:
1. Look for a tensor with last dimension = 5 → [N, 5] flat [x1,y1,x2,y2,score] format
2. Match score tensors (1 value/anchor) with bbox tensors (4 values/anchor) by total element count
Followed by IoU-based NMS (threshold 0.4).

**Channel order:** Sharp outputs RGB; the SCRFD ONNX model is treated as expecting RGB. If detection recall is poor on real images after model deployment, swap R and B channels in `bufferToDetectionFloat32()`.
