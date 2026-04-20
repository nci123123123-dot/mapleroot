FROM python:3.11-slim

WORKDIR /app

# 시스템 의존성
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Python 패키지
COPY requirements_server.txt .
RUN pip install --no-cache-dir -r requirements_server.txt

# EasyOCR 모델 사전 다운로드 (빌드 시 1회 — 배포 후 지연 없음)
RUN python -c "import easyocr; easyocr.Reader(['en'], gpu=False)" \
    && echo "EasyOCR 모델 다운로드 완료"

COPY ocr_server.py .

EXPOSE 8000

CMD ["uvicorn", "ocr_server:app", "--host", "0.0.0.0", "--port", "8000"]
