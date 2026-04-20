from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import easyocr
import cv2
import numpy as np
import asyncio
import time
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://maple-10e37.web.app",
        "https://maple-10e37.firebaseapp.com",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

logger.info("Loading EasyOCR...")
reader = easyocr.Reader(['en'], gpu=False)
logger.info("EasyOCR ready")

_last_request: dict = {}
MIN_INTERVAL = 0.4

def preprocess(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    scale = max(1, min(4, 80 // max(h, 1)))
    if scale > 1:
        img = cv2.resize(img, (w * scale, h * scale), interpolation=cv2.INTER_CUBIC)

    if len(img.shape) == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img.copy()

    gray = cv2.copyMakeBorder(gray, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=0)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    white_px = np.sum(binary == 255)
    black_px = np.sum(binary == 0)
    if black_px > white_px:
        binary = cv2.bitwise_not(binary)

    kernel = np.ones((2, 2), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)

    return binary

@app.post("/ocr")
async def ocr(file: UploadFile = File(...), client_id: str = "default"):
    now = time.monotonic()
    last = _last_request.get(client_id, 0)
    if now - last < MIN_INTERVAL:
        await asyncio.sleep(MIN_INTERVAL - (now - last))
    _last_request[client_id] = time.monotonic()

    contents = await file.read()
    if len(contents) > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large")

    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="Invalid image")

    processed = preprocess(img)

    results = reader.readtext(
        processed,
        allowlist='0123456789',
        detail=1,
        paragraph=False,
        min_size=5,
    )

    if not results:
        return {"value": None, "confidence": 0.0, "raw": ""}

    best = max(results, key=lambda x: x[2])
    raw_text = best[1].strip()
    confidence = float(best[2])

    try:
        value = int(raw_text)
        logger.info(f"OCR: '{raw_text}' -> {value} (conf={confidence:.2f})")
        return {"value": value, "confidence": confidence, "raw": raw_text}
    except ValueError:
        return {"value": None, "confidence": confidence, "raw": raw_text}

@app.get("/health")
def health():
    return {"status": "ok", "ocr": "ready"}
