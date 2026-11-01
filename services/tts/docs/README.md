# Offline TTS

Private CPU Piper service, one replica per site and local Mac by default. No public ingress.
Call `POST http://tts.soloapp.svc.cluster.local:8179/synthesize` with JSON `{"text":"Привет!"}` from the application pod; the response is PCM WAV. `/healthz` reports readiness after model warmup.
NetworkPolicy admits only `whoami` (soloapp_app). No outbound traffic, credentials, audio storage, or text logging.

`tts_overrides` in site Ansible inventory configures `replicas`, `threads` (default 2), and `max_chars` (default 1000). Mac accepts the same values under `tts` in local config.yaml. At most one synthesis per pod; excess requests return 429 with Retry-After: 1. Invalid JSON/text returns 400, inference failure 503. Caller must bound its timeout and retry 429 with backoff.

The model is built into the immutable image; synthesis works without internet. Build on Mac or GitHub, deploy separately with the `tts` workflow scope. The internal API is infrastructure for application integration; browser playback is not automatically enabled.

## Third-party components

Piper 1.8.0: GPL-3.0, https://github.com/OHF-Voice/piper1-gpl (separate container; upstream source and license apply).
Voice: `rhasspy/piper-voices`, `ru_RU-denis-medium`, revision `b4e358ffcb232591bf73a540e70f7de528e4174a`. The bundled MODEL_CARD identifies the dataset as CC0. Repository model files carry MIT terms; preserve upstream notices when distributing images.
https://huggingface.co/rhasspy/piper-voices/blob/b4e358ffcb232591bf73a540e70f7de528e4174a/ru/ru_RU/denis/medium/MODEL_CARD
