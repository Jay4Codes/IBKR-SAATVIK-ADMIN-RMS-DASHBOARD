from __future__ import annotations

import base64
import hashlib
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import settings

_PREFIX = "v1:"


class SecretUnavailable(RuntimeError):
    pass


def _key() -> bytes:
    material = settings.secret_key.strip()
    if not material:
        raise SecretUnavailable(
            "SECRET_KEY is not configured; broker secrets cannot be stored or read"
        )
    return hashlib.sha256(material.encode()).digest()


def available() -> bool:
    return bool(settings.secret_key.strip())


def encrypt(plaintext: str) -> str:
    nonce = os.urandom(12)
    sealed = AESGCM(_key()).encrypt(nonce, plaintext.encode(), None)
    return _PREFIX + base64.urlsafe_b64encode(nonce + sealed).decode()


def decrypt(ciphertext: str) -> str:
    if not ciphertext.startswith(_PREFIX):
        raise SecretUnavailable("Stored secret is not in a recognised format")
    raw = base64.urlsafe_b64decode(ciphertext[len(_PREFIX) :].encode())
    try:
        return AESGCM(_key()).decrypt(raw[:12], raw[12:], None).decode()
    except InvalidTag as exc:
        raise SecretUnavailable(
            "Stored secret could not be decrypted; SECRET_KEY may have changed"
        ) from exc
