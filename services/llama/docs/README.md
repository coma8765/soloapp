# Llama for the professor

Llama 3.2 1B Instruct Q4_K_M, model revision 067b946cf014b7c697f3654f621d577a3e3afd1c, packaged offline in a pinned llama.cpp CPU image. Model terms: Meta Llama 3.2 Community License; https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF . Built with Llama. No model weights belong in git.

Deploy on home and the independent Mac Kubernetes contour. The YC ingress routes only `/api/v1/soloapp_app/v1/professor/respond` to home's authenticated nginx; model access stays inside the home cluster. Home loss makes the public professor unavailable; game traffic keeps its existing two-site routing. Mac operates offline independently.

One replica, 2048-token context, one inference slot, four CPU threads. NetworkPolicy admits only soloapp_app (`app=whoami`), denies egress, and mounts no credentials. `llama_overrides` (Mac `llama` config) controls replicas/threads. Readiness waits for model loading. Responses are generated without tools or durable conversation storage. Do not use the generated text as verified technical instruction.

Private API: `http://llama:8180/v1/chat/completions`, model alias `llama-3.2-1b-instruct`. Public orchestration lives in soloapp_app docs/api.yaml. The browser sends only its own enabled voicechat microphone near a professor; silence ends a turn, with an eight-second cap. It stops capturing professor turns while awaiting/playing a response, and discards pending work on leaving a professor.

## Validation and quality limits

Tested real ARM64 inference with networking disabled and a read-only filesystem, authenticated HTTPS audio-to-answer requests, and TTS outage (text is preserved). Silence segmentation, the 8-second cap, one pending turn, cancellation, and recovery have automated JS tests.

The requested 1B model is not reliable as a Russian science tutor: direct Russian probes produced mixed-language and incorrect statements; even a simple arithmetic probe failed. The English probe was fluent but contained a factual error. Whisper base also mistranscribed the synthetic Russian question about the sky. These are observed model-quality limitations, not evidence that the HTTP pipeline failed. Do not treat a successful smoke test as an accuracy benchmark. No model substitution was made.
