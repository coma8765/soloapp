FROM --platform=$BUILDPLATFORM python:3.12-slim-bookworm AS model
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir ctranslate2==4.6.0 transformers==4.55.4 huggingface-hub==0.36.0 numpy==2.2.6
ENV HF_HUB_DISABLE_IMPLICIT_TOKEN=1
RUN hf download openai/whisper-large-v3-turbo --revision 41f01f3fe87f28c78e2fbf8b568835947dd65ed9 --local-dir /source --include '*.json' '*.txt' '*.safetensors' README.md
RUN HF_HUB_OFFLINE=1 ct2-transformers-converter --model /source --output_dir /model --quantization int8 --load_as_float16 --copy_files tokenizer.json preprocessor_config.json \
    && cp /source/README.md /model/MODEL_CARD.md \
    && chmod -R a+rX /model

FROM python:3.12-slim-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
COPY services/whisper/deploy/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
ENV HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HUB_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENV WHISPER_MODEL_ID=openai/whisper-large-v3-turbo
COPY --from=model /model /model
RUN test -s /model/model.bin && test -s /model/tokenizer.json && test -s /model/preprocessor_config.json
COPY services/whisper/src /app
USER 10001:10001
EXPOSE 8178
ENTRYPOINT ["python3", "/app/server.py", "--model", "/model"]
