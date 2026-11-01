# Whisper

Private CPU/int8 transcription, one independent pod in each site. Model: openai/whisper-large-v3-turbo, revision 41f01f3fe87f28c78e2fbf8b568835947dd65ed9 (MIT), converted directly from the official safetensors to CTranslate2 INT8, bundled at build time; runtime network egress is denied. Russian word timestamps; up to 8 seconds PCM16 mono/16kHz WAV. Audio and text are never written to disk or logs. Only one inference per pod; excess work returns 429. Browser retains the transcript locally.

Public API is defined in services/soloapp_app/docs/api.yaml, authenticated by nginx and validated by the C++ backend using signed identity. Only whoami pods may access the internal Service. Browser microphone permission remains explicit. In YC/home audio is sent to our servers, not a third-party recognition API. The Mac contour processes audio in its local cluster.

Build locally/CI: make -C services/whisper build. Production workflow: service=whisper. Per-site whisper_overrides controls replicas, cpu_request (millicores), memory_request and memory_limit (MiB). Defaults: 1 replica, 500m/1536Mi requested, 2 CPU/2560Mi limit. Mac uses the same overrides from its whisper config. Restarted pods load model before readiness. Existing audio requests may fail during a site outage; the user can retry. No persistent audio queue.

## GPU deployment

Home sets `whisper_overrides.gpu: true`. The worker requires CUDA and uses
`int8_float16`; an unavailable GPU is a startup error, never a CPU fallback.
Install the runtime and device plugin with `infra/gpu/install.yaml` before rollout.
The pod reserves one `nvidia.com/gpu`. A single GPU requires `Recreate`, so Whisper
has a short interruption during updates. No GPU time-sharing is enabled.
YC remains CPU unless explicitly configured with a GPU.

On Apple Silicon, the Colima Linux VM cannot expose Metal to pods. Run
`python3.12 services/whisper/deploy/macos/install.py` on the Mac. This installs a
launch agent using MLX/Metal, bound to `127.0.0.1:8178`. The model is the MLX
conversion `mlx-community/whisper-large-v3-turbo`, pinned to
`a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb` (FP16). Inference runs offline.
The agent starts at user login; the Mac must be awake and the user logged in.
After verifying health, configure local `whisper.metal_host: 192.168.5.2`.
This is Colima's host-only `host.lima.internal`, not the Mac's LAN IP.
The local renderer scales the CPU deployment to zero, routes the existing
Service through an EndpointSlice, and allows only the application egress to
that host/port. It does not expose the inference worker on the LAN.

`/healthz` reports `device: cuda`, `metal`, or `cpu`. Verify this and GPU
utilization with a real transcription; readiness alone is not a GPU benchmark.
