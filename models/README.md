# Model registry (local-first AI)

Per the MASTER directive all ML runs locally in the extension first; the
backend gateway is a remote-fallback only. Models are lazy-loaded — never
shipped with the MV3 worker — and quantized where possible.

| Purpose        | Provider                 | Runtime            | Sizes (quantized)   |
| -------------- | ------------------------ | ------------------ | ------------------- |
| OCR            | PaddleOCR (text box)     | WASM / WebGPU      | det ~3 MB, rec ~4 MB |
| Classification | Transformers.js (BERT)   | WebGPU / WASM      | ~15–30 MB (Q8)      |
| Element vision | Transformers.js (GT/Swin)| WebGPU             | ~50–100 MB          |
| Planning LLM   | Remote gateway (later)   | backend FastAPI    | N/A                 |
| VLM (screens)  | Remote gateway (later)   | backend FastAPI    | N/A                 |

## Layout

```
models/
  paddleocr/        # PaddleOCR-compatible ONNX: det + rec models
  transformers/     # onnx-format checkpoints for classification
  vision/           # image encoders used by the element-vision provider
  README.md
```

## Loading rules

1. The worker never statically imports a model.
2. `vision/providers.ts` detects capabilities (WebGPU → WASM → CPU) before
   fetching weights; weights stream from a mutable model store (CDN or local
   `chrome.runtime.getURL`) only after a provider is first needed.
3. Fail loudly, never fake: `ready() === false` means "not loaded", and
   `PaddleOcrProvider.recognize()` returns `""` until the runtime is present.
4. PII and redaction stay in the extension tier; OCR output is scanned by the
   Privacy Firewall before it can reach the backend.

## Quantization defaults

- OCR text boxes: fp16 → Q8 for CUDA/WebGPU, float32 otherwise.
- Classification checkedpoints: Q8 (Q4 if accuracy budget allows).
- Never upload raw screenshots; send encodings after the firewall scan.