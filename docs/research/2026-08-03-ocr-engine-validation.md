# Research — OCR engine validation (spec 14 evidence) — 2026-08-03

> Evidence for the OCR write-path decision in `docs/specs/14-ocr-tesseract.md` (engine
> choice locked to Tesseract; the 5-image spot-check criterion was never recorded).
> Researched 2026-08-03 via free-pool swarm + main-session verification.
> Workload: screenshots, receipts, Keep-imported images; Windows 10 IoT LTSC; CPU-only
> (AMD 7900X, no discrete GPU); mixed EN/CJK text.

## Status: COMPLETED (research only — no code changed)

## Bottom line
**Keep Tesseract as the primary engine; add PaddleOCR as a fallback for complex layouts**
(photos of receipts, curved/handwriting-heavy content). Record a 30-image spot-check
(mix below) to settle the decision with evidence instead of the unrecorded 5-image check.

## Key facts
- Published comparisons consistently show **PaddleOCR ahead on hard inputs** — e.g. curved
  text 88.7% vs Tesseract 52.1%, noisy scans 91.5% vs 84.3%, handwriting 72.8% vs 45.2%
  (gigagpu comparison); OmniDocBench ~94.5% claims for PaddleOCR on documents
  (koncile.ai); peer-reviewed 2024 study: Tesseract ~92% on clean English text.
- On clean screenshots/typed text the gap narrows — Tesseract is fine for the common
  case and is the lighter, established engine (winget-installed already).
- Windows packaging: PaddleOCR/EasyOCR are pip-installable on Windows CPU (PaddlePaddle
  has Windows wheels), but Paddle is heavier to configure and slower CPU-only; EasyOCR
  sits between the two.
- A local vision model (e.g. Qwen2.5-VL-3B/7B via LM Studio) is viable for hard OCR but
  overkill as the default path on this hardware.

## Spot-check protocol (proposed)
- 30 images: ~15 clean screenshots, ~10 receipt photos (angle/shadows), ~5 CJK-heavy or
  handwriting samples.
- Measure: character-level accuracy on known text + wall-clock per image (CPU).
- Gate: if PaddleOCR beats Tesseract by >5% accuracy on the receipt photo set, wire it as
  an engine fallback (per-layout routing) rather than replacing Tesseract.

## Decision impact
- Content-hoarder: keep `ocr.py` Tesseract default; add the injectable PaddleOCR fallback
  behind the spot-check gate (the `default_engine()` seam already exists).
- PKMS (shared decision): same conclusion applies to its build-plan OCR line.

## Sources
- https://gigagpu.com/paddleocr-vs-tesseract-vs-easyocr/ (curved/noise/handwriting numbers)
- https://www.koncile.ai/en/ressources/paddleocr-analyse-avantages-alternatives-open-source (OmniDocBench claim)
- https://invoicedataextraction.com/blog/python-ocr-library-comparison-invoices (2024 peer-reviewed benchmark)
- https://www.codesota.com/ocr/paddleocr-vs-tesseract (same-invoice run, 2026)
- https://github.com/PaddlePaddle/PaddleOCR/discussions/8349
