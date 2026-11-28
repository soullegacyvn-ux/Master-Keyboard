"""Ed25519 envelopes shared by the Decky client and the store."""
import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

LIMIT = 2_000_000
OPENSSL = "/usr/bin/openssl"
COLLECTION = "pro-1"
PUBLIC_COLLECTION = "masterkeyboard-pro"
TRIAL_COLLECTION = "masterkeyboard-trial"
TRIAL_DURATION = 24 * 60 * 60
LIFETIME_PRICE_USD = "4.99"
PREMIUM = {"Terminal", "Studio", "Console", "Cyber"}
STYLESHEET = re.compile(r"[a-z][a-z0-9-]*\.css")


def openssl_env():
    """Environment for the system openssl.

    Decky Loader is a PyInstaller bundle and points LD_LIBRARY_PATH at its own
    libssl/libcrypto. The system openssl binary cannot run against those, so
    restore the library path the loader started with.
    """
    env = dict(os.environ)
    original = env.pop("LD_LIBRARY_PATH_ORIG", None)
    if original:
        env["LD_LIBRARY_PATH"] = original
    else:
        env.pop("LD_LIBRARY_PATH", None)
    return env


def encode(data):
    return base64.b64encode(data).decode("ascii")


def decode(data):
    return base64.b64decode(data, validate=True)


def sign(payload, private_key):
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    if len(body) > LIMIT:
        raise ValueError("Collection is too large")
    with TemporaryDirectory() as directory:
        message = Path(directory) / "message"
        message.write_bytes(body)
        signature = subprocess.run(
            [OPENSSL, "pkeyutl", "-sign", "-rawin", "-inkey", str(private_key), "-in", str(message)],
            check=True, capture_output=True, timeout=5, env=openssl_env(),
        ).stdout
    return {"body": encode(body), "signature": encode(signature)}


def verify(envelope, public_key, device, *, collection=COLLECTION, premium=PREMIUM,
           bundle_collection=None):
    if not isinstance(envelope, dict) or not isinstance(envelope.get("body"), str) or not isinstance(envelope.get("signature"), str):
        raise ValueError("Invalid entitlement")
    if len(envelope["body"]) > LIMIT * 4 // 3 + 4 or len(envelope["signature"]) != 88:
        raise ValueError("Invalid entitlement size")
    body = decode(envelope["body"])
    signature = decode(envelope["signature"])
    with TemporaryDirectory() as directory:
        directory = Path(directory)
        key, message, signed = (directory / name for name in ("public", "message", "signature"))
        key.write_text(public_key, encoding="ascii")
        message.write_bytes(body)
        signed.write_bytes(signature)
        result = subprocess.run(
            [OPENSSL, "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(key),
             "-in", str(message), "-sigfile", str(signed)],
            capture_output=True, timeout=5, env=openssl_env(),
        )
    if result.returncode != 0:
        raise ValueError("Invalid entitlement signature")
    data = json.loads(body)
    if not isinstance(data, dict) or data.get("collection") != collection or data.get("device") != device:
        raise ValueError("Entitlement is for another device or collection")
    if "bundle_sha256" in data:
        encoded_bundle = envelope.get("bundle")
        digest = data["bundle_sha256"]
        if (not isinstance(encoded_bundle, str) or len(encoded_bundle) > LIMIT * 4 // 3 + 4
                or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
            raise ValueError("Invalid entitlement bundle")
        bundle_bytes = decode(encoded_bundle)
        if len(bundle_bytes) > LIMIT or not hmac.compare_digest(hashlib.sha256(bundle_bytes).hexdigest(), digest):
            raise ValueError("Entitlement bundle does not match its signature")
        bundle = json.loads(bundle_bytes)
        if not isinstance(bundle, dict) or bundle.get("id") != (bundle_collection or collection):
            raise ValueError("Malformed entitlement bundle")
        data = {**data, "profiles": bundle.get("profiles"), "sheets": bundle.get("sheets")}
    if (not isinstance(profiles := data.get("profiles"), dict) or set(profiles) != premium
            or not isinstance(sheets := data.get("sheets"), dict)):
        raise ValueError("Malformed entitlement bundle")
    if not all(STYLESHEET.fullmatch(name) and isinstance(css, str) for name, css in sheets.items()):
        raise ValueError("Malformed collection")
    for profile in profiles.values():
        if (not isinstance(profile, dict) or not isinstance(profile.get("label"), str)
                or not isinstance(profile.get("height"), int) or not isinstance(profile.get("sheets"), list)
                or not all(isinstance(sheet, str) and STYLESHEET.fullmatch(sheet) for sheet in profile["sheets"])
                or not isinstance(profile.get("colors"), dict)):
            raise ValueError("Malformed collection profile")
    return data
