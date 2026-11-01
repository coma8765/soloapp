FROM python:3.12-slim-bookworm AS model
RUN pip install --no-cache-dir huggingface-hub==0.36.0
ENV HF_HUB_DISABLE_IMPLICIT_TOKEN=1
RUN hf download bartowski/Llama-3.2-1B-Instruct-GGUF Llama-3.2-1B-Instruct-Q4_K_M.gguf README.md --revision 067b946cf014b7c697f3654f621d577a3e3afd1c --local-dir /model && chmod -R a+rX /model
FROM ghcr.io/ggml-org/llama.cpp:server@sha256:d9e9e74ba3f7ef119b1939162b1631f99b75ec703c310d140cfa2fdac8907389 AS runtime
COPY --from=model /model/Llama-3.2-1B-Instruct-Q4_K_M.gguf /model/model.gguf
COPY --from=model /model/README.md /model/MODEL_CARD.md
USER 10001:10001
EXPOSE 8180
ENTRYPOINT ["/app/llama-server"]
CMD ["--model", "/model/model.gguf", "--host", "0.0.0.0", "--port", "8180", "--ctx-size", "2048", "--parallel", "1", "--threads", "4", "--n-gpu-layers", "0", "--alias", "llama-3.2-1b-instruct", "--log-disable"]
