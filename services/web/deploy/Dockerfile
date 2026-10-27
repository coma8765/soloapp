FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/libs
COPY libs/storage/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY libs/storage /app/libs/storage
COPY services/web/deploy/gateway.py /app/gateway.py
USER 10001:10001
ENTRYPOINT ["python3", "/app/gateway.py"]
