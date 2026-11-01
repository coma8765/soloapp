FROM python:3.12-slim-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir piper-tts==1.8.0 huggingface-hub==0.36.0
ENV HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HUB_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ARG MODEL_REVISION=b4e358ffcb232591bf73a540e70f7de528e4174a
RUN HF_HUB_OFFLINE=0 hf download rhasspy/piper-voices --revision ${MODEL_REVISION} --local-dir /download ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx.json ru/ru_RU/denis/medium/MODEL_CARD \
 && mkdir /model && cp /download/ru/ru_RU/denis/medium/* /model/ && rm -rf /download && chmod -R a+rX /model
COPY services/tts/src /app
USER 10001:10001
EXPOSE 8179
ENTRYPOINT ["python3", "/app/server.py"]
