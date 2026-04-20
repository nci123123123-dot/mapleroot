FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements_server.txt .

# CPU-only torch first (smaller), then rest
RUN pip install --no-cache-dir \
    torch==2.2.0+cpu torchvision==0.17.0+cpu \
    --extra-index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir \
    fastapi==0.111.0 \
    uvicorn[standard]==0.30.1 \
    python-multipart==0.0.9 \
    opencv-python-headless==4.9.0.80 \
    numpy==1.26.4 \
    easyocr==1.7.1

# Pre-download EasyOCR models
RUN python -c "import easyocr; easyocr.Reader(['en'], gpu=False)"

# Clean pip cache to reduce image size
RUN pip cache purge

COPY ocr_server.py .

EXPOSE 8000

CMD ["uvicorn", "ocr_server:app", "--host", "0.0.0.0", "--port", "8000"]
