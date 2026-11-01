import copy
import importlib.util
import io
import unittest
from unittest.mock import patch
import wave
from pathlib import Path


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


updater = load("local_update", "update.py")
speech = load("local_speech", "check-speech.py")


class LocalUpdateTests(unittest.TestCase):
    def config(self):
        return {
            "profile": "soloapp-local",
            "namespace": "soloapp",
            "lan": {"ip": "192.168.1.100", "https_port": 443},
            "whisper": {"metal_host": "192.168.5.2"},
        }

    def test_rejects_production_and_cpu_contours(self):
        updater.validate_config(self.config())
        for field, value in [("profile", "yc"), ("namespace", "default"), ("whisper", {})]:
            config = self.config()
            config[field] = value
            with self.assertRaises(ValueError):
                updater.validate_config(config)
        config = self.config()
        config["lan"]["ip"] = "0.0.0.0"
        with self.assertRaises(ValueError):
            updater.validate_config(config)

    def test_manifest_pins_runtime_without_changing_secrets_or_scaling(self):
        document = {
            "kind": "Deployment",
            "metadata": {"name": "whoami"},
            "spec": {
                "replicas": 2,
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "image": "old",
                                "env": [
                                    {
                                        "name": "TOKEN",
                                        "valueFrom": {
                                            "secretKeyRef": {"name": "existing", "key": "token"}
                                        },
                                    }
                                ],
                            }
                        ]
                    }
                },
            },
        }
        original = copy.deepcopy(document)
        result = updater.pin_manifest([document], {"whoami": "local:pinned"})[0]
        container = result["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(container["image"], "local:pinned")
        self.assertEqual(container["imagePullPolicy"], "Never")
        self.assertEqual(
            container["env"], original["spec"]["template"]["spec"]["containers"][0]["env"]
        )
        self.assertEqual(result["spec"]["replicas"], 2)

    def test_native_whisper_cannot_be_replaced_by_cpu_pods(self):
        document = {"kind": "Deployment", "metadata": {"name": "whisper"}, "spec": {"replicas": 1}}
        with self.assertRaises(ValueError):
            updater.pin_manifest([document], {})

    def test_check_rejects_one_unready_replica_even_when_api_works(self):
        deployments = [
            {
                "metadata": {"name": name, "generation": 2},
                "spec": {"replicas": 2},
                "status": {"readyReplicas": 2, "updatedReplicas": 2, "observedGeneration": 2},
            }
            for name in updater.SERVICES
        ]
        updater.require_ready(deployments)
        deployments[1]["status"]["readyReplicas"] = 1
        with self.assertRaisesRegex(RuntimeError, "whoami 1/2"):
            updater.require_ready(deployments)

    def test_port_forward_is_terminated_when_check_fails(self):
        import tempfile

        class FailedCheck(RuntimeError):
            pass

        with tempfile.TemporaryFile(mode="w+") as log:
            log.write("Forwarding from 127.0.0.1:12345 -> 8179\n")
            log.flush()
            with (
                patch.object(updater.tempfile, "TemporaryFile", return_value=log),
                patch.object(updater.subprocess, "Popen") as start,
            ):
                process = start.return_value
                process.poll.return_value = None
                with self.assertRaises(FailedCheck):
                    with updater.port_forward("tts", 8179) as endpoint:
                        self.assertTrue(endpoint.startswith("http://127.0.0.1:"))
                        raise FailedCheck("speech rejected")
                process.terminate.assert_called_once()
                process.wait.assert_called_once_with(timeout=10)
                process.kill.assert_not_called()

    def test_question_resampling_keeps_bounded_pcm_contract(self):
        original = io.BytesIO()
        with wave.open(original, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(22050)
            audio.writeframes(b"\x01\x00" * 22050)
        with wave.open(io.BytesIO(speech.pcm16_16khz(original.getvalue())), "rb") as audio:
            self.assertEqual(
                (
                    audio.getnchannels(),
                    audio.getsampwidth(),
                    audio.getframerate(),
                    audio.getnframes(),
                ),
                (1, 2, 16000, 16000),
            )


if __name__ == "__main__":
    unittest.main()
