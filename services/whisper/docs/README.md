# Whisper

Private CPU/int8 transcription, one independent pod in each site. Model: openai/whisper-large-v3-turbo, revision 41f01f3fe87f28c78e2fbf8b568835947dd65ed9 (MIT), converted directly from the official safetensors to CTranslate2 INT8, bundled at build time; runtime network egress is denied. Russian word timestamps; up to 8 seconds PCM16 mono/16kHz WAV. Audio and text are never written to disk or logs. Only one inference per pod; excess work returns 429. Browser retains the transcript locally.

Public API is defined in services/soloapp_app/docs/api.yaml, authenticated by nginx and validated by the C++ backend using signed identity. Only whoami pods may access the internal Service. Browser microphone permission remains explicit. In YC/home audio is sent to our servers, not a third-party recognition API. The Mac contour processes audio in its local cluster.

Build locally/CI: make -C services/whisper build. Production workflow: service=whisper. Per-site whisper_overrides controls replicas, cpu_request (millicores), memory_request and memory_limit (MiB). Defaults: 1 replica, 500m/1536Mi requested, 2 CPU/2560Mi limit. Mac uses the same overrides from its whisper config. Restarted pods load model before readiness. Existing audio requests may fail during a site outage; the user can retry. No persistent audio queue.
