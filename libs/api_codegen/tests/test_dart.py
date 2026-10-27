import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from generate_dart import ROOT, render


class DartTests(unittest.TestCase):
    def test_public_contract_only(self):
        text = render(ROOT / "services/auth")
        self.assertIn("/api/v1/auth/v1/login", text)
        self.assertNotIn("/internal/verify", text)
        self.assertNotIn("'/auth/login'", text)
        self.assertIn("expectedStatus: 204", text)

    def test_gateway_identity_uses_bearer_not_signed_headers(self):
        text = render(ROOT / "services/whoami")
        self.assertIn("accessToken: accessToken", text)
        self.assertNotIn("X-User-Signature", text)

    def test_chat_array_and_post_are_generated_from_contract(self):
        text = render(ROOT / "services/app-api")
        self.assertIn("List<ApiChatMessage>", text)
        self.assertIn("Future<ApiChatMessage> chatSend", text)
        self.assertIn("transport.request('POST', '/api/v1/app-api/v1/chat/messages'", text)
        self.assertIn("clientId", text)
        self.assertNotIn("X-Verified-User-Id", text)
