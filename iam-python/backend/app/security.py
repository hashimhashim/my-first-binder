"""Authentication, JWT, MFA (TOTP), and credential encryption."""
from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timedelta, timezone

import pyotp
from jose import JWTError, jwt
from passlib.context import CryptContext

from .config import get_settings

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
_settings = get_settings()


def hash_password(password: str) -> str:
    return _pwd.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    return _pwd.verify(password, password_hash)


def create_access_token(subject: str, claims: dict | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "iat": now,
        "exp": now + timedelta(minutes=_settings.access_token_ttl_minutes),
        **(claims or {}),
    }
    return jwt.encode(payload, _settings.jwt_secret, algorithm=_settings.jwt_algorithm)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, _settings.jwt_secret, algorithms=[_settings.jwt_algorithm])
    except JWTError:
        return None


# -- MFA (TOTP) ---------------------------------------------------------------
def new_mfa_secret() -> str:
    return pyotp.random_base32()


def mfa_provisioning_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name="Enterprise IAM")


def verify_totp(secret: str, code: str) -> bool:
    return pyotp.TOTP(secret).verify(code, valid_window=1)


# -- credential encryption (symmetric, key from settings) ---------------------
def _fernet():
    from cryptography.fernet import Fernet

    key = hashlib.sha256(_settings.credential_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_credentials(data: dict) -> str:
    import json

    return _fernet().encrypt(json.dumps(data).encode()).decode()


def decrypt_credentials(token: str | None) -> dict:
    if not token:
        return {}
    import json

    try:
        return json.loads(_fernet().decrypt(token.encode()).decode())
    except Exception:  # noqa: BLE001
        return {}
