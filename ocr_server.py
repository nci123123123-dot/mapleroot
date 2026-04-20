"""
솔 에르다 조각 OCR 서버 — FastAPI + EasyOCR
실행: uvicorn ocr_server:app --host 0.0.0.0 --port 8000
"""

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

# ── CORS: Firebase 도메인 + 로컬 테스트 허용 ──────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://maple-10e37.web.app",
        "https://maple-10e37.firebaseapp.com",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_methods=["POST"],
    allow_headers=["*"],
)

# ── EasyOCR 초기화 (서버 시작 시 1회) ───────────────────────────────────────
logger.info("[OCR] EasyOCR 로딩 중...")
reader = easyocr.Reader(['en'], gpu=False)
logger.info("[OCR] 로딩 완료")

# ── 요청 빈도 제어 (클라이언트당 최소 0.4초 간격) ─────────────────────────────
_last_request: dict[str, float] = {}
MIN_INTERVAL = 0.4  # seconds

# ── 전처리 ───────────────────────────────────────────────────────────────────
def preprocess(img: np.ndarray) -> np.ndarray:
    """게임 UI 숫자 인식에 최적화된 전처리"""
    # 업스케일 (작은 이미지일수록 정확도 향상)
    h, w = img.shape[:2]
    scale = max(1, min(4, 80 // max(h, 1)))
    if scale > 1:
        img = cv2.resize(img, (w * scale, h * scale), interpolation=cv2.INTER_CUBIC)

    # 그레이스케일
    if len(img.shape) == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img.copy()

    # 패딩 추가 (EasyOCR가 가장자리 텍스트를 놓치지 않도록)
    gray = cv2.copyMakeBorder(gray, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=0)

    # 이진화 — OTSU (배경/텍스트 자동 분리)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # 흰 배경 + 검정 텍스트로 정규화 (EasyOCR 선호)
    white_px = np.sum(binary == 255)
    black_px = np.sum(binary == 0)
    if black_px > white_px:
        binary = cv2.bitwise_not(binary)

    # 노이즈 제거
    kernel = np.ones((2, 2), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)

    return binary

# ── /ocr 엔드포인트 ───────────────────────────────────────────────────────────
@app.post("/ocr")
async def ocr(
    file: UploadFile = File(...),
    client_id: str = "default",
):
    # 요청 빈도 제어
    now = time.monotonic()
    last = _last_request.get(client_id, 0)
    if now - last < MIN_INTERVAL:
        wait = MIN_INTERVAL - (now - last)
        await asyncio.sleep(wait)
    _last_request[client_id] = time.monotonic()

    # 이미지 디코딩
    contents = await file.read()
    if len(contents) > 2 * 1024 * 1024:  # 2MB 초과 거부
        raise HTTPException(status_code=413, detail="이미지가 너무 큽니다")

    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="이미지 디코딩 실패")

    # 전처리
    processed = preprocess(img)

    # EasyOCR — 숫자만 인식
    results = reader.readtext(
        processed,
        allowlist='0123456789',
        detail=1,
        paragraph=False,
        min_size=5,
    )

    if not results:
        return {"value": None, "confidence": 0.0, "raw": ""}

    # 신뢰도 기준으로 최적 결과 선택
    best = max(results, key=lambda x: x[2])
    raw_text = best[1].strip()
    confidence = float(best[2])

    try:
        value = int(raw_text)
        logger.info(f"[OCR] '{raw_text}' → {value} (conf={confidence:.2f})")
        return {"value": value, "confidence": confidence, "raw": raw_text}
    except ValueError:
        return {"value": None, "confidence": confidence, "raw": raw_text}


@app.get("/health")
def health():
    return {"status": "ok", "ocr": "ready"}
