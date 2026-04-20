FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Pin numpy<2 first (torch 2.2 was compiled against numpy 1.x)
RUN pip install --no-cache-dir "numpy<2"

# CPU-only torch
RUN pip install --no-cache-dir \
    torch==2.2.0+cpu torchvision==0.17.0+cpu \
    --extra-index-url https://download.pytorch.org/whl/cpu

# Remaining dependencies
COPY requirements_server.txt .
RUN pip install --no-cache-dir -r requirements_server.txt

# Pre-download EasyOCR models
RUN python -c "import easyocr; easyocr.Reader(['en'], gpu=False)"

RUN pip cache purge

COPY ocr_server.py .

EXPOSE 8000

CMD ["uvicorn", "ocr_server:app", "--host", "0.0.0.0", "--port", "8000"]
