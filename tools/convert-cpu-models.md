# Converting the MediaPipe models for the WebGL-free engine

The files in `models/onnx-cpu/` are the bundled MediaPipe models (Apache-2.0), converted to ONNX without changing
their weights. `src/ai/cpu-engine.js` checks their SHA-256 before use.

```sh
python3 -m venv venv && . venv/bin/activate
pip install tensorflow-cpu==2.21.0 tf2onnx==1.17.0 onnx onnxruntime==1.31.1
unzip models/mediapipe/face_landmarker.task face_detector.tflite face_landmarks_detector.tflite -d /tmp/fl
python -m tf2onnx.convert --tflite /tmp/fl/face_detector.tflite --output models/onnx-cpu/face_detector.onnx --opset 17
python -m tf2onnx.convert --tflite /tmp/fl/face_landmarks_detector.tflite --output models/onnx-cpu/face_landmarks_detector.onnx --opset 17
python -m tf2onnx.convert --tflite models/mediapipe/selfie_multiclass_256x256.tflite --output models/onnx-cpu/selfie_multiclass_256x256.onnx --opset 17
sha256sum models/onnx-cpu/*.onnx   # update CPU_FILES in src/ai/cpu-engine.js
```

Pre- and post-processing that reproduces MediaPipe (checked against MediaPipe's own output):

| Model | Input | Output |
|---|---|---|
| face detector | letterboxed to 128×128 RGB, values −1…1 | 896 anchors (16×16×2 at stride 8, 8×8×6 at stride 16); box and 6 keypoints ÷128 + anchor; sigmoid score ≥ 0.5; NMS IoU 0.3 |
| face landmarks | square of 1.5 × the larger box side, rotated so the eyes are level, 256×256 RGB, values 0…1 | 478 × (x, y, z) in crop pixels, mapped back with the crop's affine; presence logit → sigmoid ≥ 0.5 |
| selfie multiclass | stretched to 256×256 RGB, values −1…1 | 256×256×6 logits → softmax, bilinear up to the image size (background, hair, body skin, face skin, clothes, others) |
