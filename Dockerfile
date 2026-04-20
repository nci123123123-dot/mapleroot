FROM python:3.11-slim

WORKDIR /app

# System dependencies
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Python packages
COPY requirements_server.txt .
RUN pip install --no-cache-dir -r requirements_server.txt

# Pre-download EasyOCR models (once at build time)
RUN python -c "import easyocr; easyocr.Reader(['en'], gpu=False)"

COPY ocr_server.py .

EXPOSE 8000

CMD ["uvicorn", "ocr_server:app", "--host", "0.0.0.0", "--port", "8000"]
