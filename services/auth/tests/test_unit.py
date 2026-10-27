import hashlib

import pytest


@pytest.mark.parametrize(
    "username,password,status",
    [
        ("Alice.Valid", "a-secure-password", 200),
        ("ab", "a-secure-password", 400),
        ("abc';DROP TABLE users;--", "a-secure-password", 400),
        ("valid", "short", 400),
        ("valid", "x" * 257, 400),
        ("valid", "x" * 12 + "\x00", 400),
        ("valid", "я" * 129, 400),
    ],
)
def test_credentials(unit_probe, username, password, status):
    result = unit_probe(
        {"command": "credentials", "body": {"username": username, "password": password}}
    )
    assert result["status"] == status
    if status == 200:
        assert result["username"] == "alice.valid"


@pytest.mark.parametrize(
    "header,status",
    [
        ("Bearer " + "a" * 64, 200),
        ("bearer " + "a" * 64, 401),
        ("Bearer " + "A" * 64, 401),
        ("Bearer " + "a" * 63, 401),
        ("Bearer " + "g" * 64, 401),
        ("", 401),
    ],
)
def test_bearer(unit_probe, header, status):
    assert unit_probe({"command": "bearer", "header": header})["status"] == status


def test_token_digest(unit_probe):
    token = "01" * 32
    assert (
        unit_probe({"command": "digest", "token": token})["digest"]
        == hashlib.sha256(token.encode()).hexdigest()
    )


def test_auth_logic_with_repository_double(unit_probe):
    result = unit_probe(
        {"command": "flow", "body": {"username": "Alice", "password": "valid-password-123"}}
    )
    assert result == {
        "status": 200,
        "identity_matches": True,
        "only_digest_stored": True,
        "password_is_argon2": True,
        "duplicate_status": 409,
        "wrong_password_status": 401,
        "revoked_status": 401,
    }
