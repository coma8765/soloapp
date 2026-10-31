FROM python:3.12-slim-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
COPY services/whisper/deploy/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
ENV HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HUB_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN HF_HUB_OFFLINE=0 hf download Systran/faster-whisper-base --revision ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66 --local-dir /model --include config.json --include model.bin --include tokenizer.json --include vocabulary.txt
COPY services/whisper/src /app
USER 10001:10001
EXPOSE 8178
ENTRYPOINT ["python3", "/app/server.py", "--model", "/model"]
