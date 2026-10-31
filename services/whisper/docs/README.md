# Whisper

Private CPU/int8 transcription, one independent pod in each site. Model: Systran/faster-whisper-base, revision ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66 (MIT), bundled at build time; runtime network egress is denied. Russian word timestamps; up to 8 seconds PCM16 mono/16kHz WAV. Audio and text are never written to disk or logs. Only one inference per pod; excess work returns 429. Browser retains the transcript locally.

Public API is defined in services/soloapp_app/docs/api.yaml, authenticated by nginx and validated by the C++ backend using signed identity. Only whoami pods may access the internal Service. Browser microphone permission remains explicit. In YC/home audio is sent to our servers, not a third-party recognition API. The Mac contour processes audio in its local cluster.

Build locally/CI: make -C services/whisper build. Production workflow: service=whisper. Per-site whisper_overrides.replicas controls replicas. Restarted pods load model before readiness. Existing audio requests may fail during a site outage; the user can retry. No persistent audio queue.
