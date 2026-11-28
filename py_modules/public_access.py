"""Public edition access, including offline use of a verified purchase."""
import asyncio
import base64
import json
import re
import ssl
import subprocess
import time
import uuid
from urllib.parse import urlsplit

import aiohttp
import certifi
from entitlement import (
    LIFETIME_PRICE_USD, LIMIT, PUBLIC_COLLECTION, TRIAL_COLLECTION, TRIAL_DURATION, verify,
)

LICENSE = re.compile(r"MK(?:-[A-Z2-7]{8}){4}")
DEVICE = re.compile(r"[a-f0-9]{32}")
CHECKOUT_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
HTTP_HEADERS = {"User-Agent": "Master-Keyboard-Decky/1.1"}
TRIAL_CLOCK_TOLERANCE = 60


def normalize_license(code):
    """Accept a license key however it was typed or pasted.

    Keys use the letters A-Z and the digits 2-7. Lower case, spaces, missing
    dashes and the look-alikes 0, 1 and 8 are all corrected before the check.
    """
    if not isinstance(code, str):
        return None
    letters = re.sub(r"[^A-Za-z0-9]", "", code).upper()
    if letters.startswith("MK"):
        letters = letters[2:]
    letters = letters.translate(str.maketrans("018", "OIB"))
    if len(letters) != 32:
        return None
    return "MK-" + "-".join(letters[index:index + 8] for index in range(0, 32, 8))


async def response_json(response, limit):
    body = bytearray()
    async for chunk in response.content.iter_chunked(min(limit, 64 * 1024)):
        body.extend(chunk)
        if len(body) > limit:
            raise ValueError("Store response exceeds the download limit.")
    return json.loads(body)


class PublicAccess:
    def __init__(self, assets, settings_dir, profiles, save, logger):
        config = json.loads((assets / "commerce.json").read_text(encoding="utf-8"))
        self.store = config.get("store")
        self.public_key = config.get("public_key")
        self.plasma = config.get("plasma")
        self.client = {"client": "decky-v2"} if config.get("bundle_client") == "decky-v2" else {}
        self.legacy_bundle = config.get("legacy_bundle") if self.client else None
        if self.store:
            url = urlsplit(self.store)
            if (url.scheme != "https" or not url.hostname or url.username or url.password
                    or url.path or url.query or url.fragment or not self.public_key):
                raise ValueError("Invalid Master Keyboard store configuration")
        self.free = frozenset(shape for index, (shape, profile) in enumerate(profiles.items(), 1)
                              if 15 <= profile.get("number", index) <= 20)
        self.fallback = "Translucent" if "Translucent" in self.free else next(shape for shape in profiles if shape in self.free)
        self.premium = profiles.keys() - self.free
        self.private_sheets = {name for shape in self.premium for name in profiles[shape]["sheets"]} - {
            name for shape in self.free for name in profiles[shape]["sheets"]
        }
        self.previews = assets / "premium-previews"
        self.save = save
        self.logger = logger
        self.activation_lock = asyncio.Lock()
        self.entitlement_file = settings_dir / "premium-entitlement.json"
        self.trial_file = settings_dir / "premium-trial.json"
        self.checkout_file = settings_dir / "pending-checkout.json"
        self.checkout = None
        self.device = None
        self.pack = None
        self.renewal = None
        self.trial_pack = None
        self.trial_deadline = 0
        self.trial_state = "unavailable"
        self.trial_status_retry_at = 0
        self.trial_status_task = None
        # Decky bundles OpenSSL and uses certifi for its own HTTPS requests.
        self.https_context = ssl.create_default_context(cafile=certifi.where())
        if not self.store:
            return
        device_file = settings_dir / "installation.json"
        try:
            device = json.loads(device_file.read_text(encoding="utf-8"))["device"]
            if not isinstance(device, str) or not DEVICE.fullmatch(device):
                raise ValueError("Invalid installation identifier")
            self.device = device
        except FileNotFoundError:
            self.device = uuid.uuid4().hex
            self.save(device_file, {"device": self.device})
        except (OSError, KeyError, TypeError, ValueError):
            logger.warning("Could not read the Master Keyboard installation identifier.")
        if self.device and self.entitlement_file.is_file():
            try:
                self.pack = self.read_saved_pack(json.loads(self.entitlement_file.read_text(encoding="utf-8")))
            except (OSError, ValueError, subprocess.SubprocessError):
                logger.warning("Saved Master Keyboard purchase could not be verified.")
        if self.trial_supported and self.pack is None:
            self.load_trial()
        if self.pack is None and self.device:
            try:
                saved = json.loads(self.checkout_file.read_text(encoding="utf-8"))
                if self.valid_checkout(saved) and saved.get("store") == self.store and saved.get("device") == self.device:
                    self.checkout = saved
            except FileNotFoundError:
                pass
            except (OSError, ValueError):
                logger.warning("Could not resume the Master Keyboard checkout.")

    @staticmethod
    def valid_checkout(checkout):
        return (
            isinstance(checkout, dict)
            and isinstance(checkout.get("id"), str) and DEVICE.fullmatch(checkout["id"])
            and isinstance(checkout.get("claim"), str) and CHECKOUT_TOKEN.fullmatch(checkout["claim"])
            and type(checkout.get("expires")) is int and checkout["expires"] > time.time()
        )

    def read_pack(self, envelope):
        pack = verify(envelope, self.public_key, self.device, collection=PUBLIC_COLLECTION, premium=self.premium)
        if set(pack["sheets"]) != self.private_sheets:
            raise ValueError("The theme download does not match this edition.")
        return pack

    def read_saved_pack(self, envelope):
        try:
            return self.read_pack(envelope)
        except ValueError:
            if self.legacy_bundle is None:
                raise
        # Only accept a previously signed bundle with the former edition's exact manifest.
        pack = verify(envelope, self.public_key, self.device, collection=PUBLIC_COLLECTION,
                      premium=set(self.legacy_bundle["profiles"]))
        if set(pack["sheets"]) != set(self.legacy_bundle["sheets"]) or "bundle_sha256" not in pack:
            raise ValueError("The saved purchase is not a supported Master Keyboard collection.")
        self.renewal = {key: envelope[key] for key in ("body", "signature")}
        return pack

    @property
    def trial_supported(self):
        return bool(self.store and self.device and self.client.get("client") == "decky-v2")

    def read_trial(self, envelope):
        pack = verify(
            envelope, self.public_key, self.device, collection=TRIAL_COLLECTION,
            bundle_collection=PUBLIC_COLLECTION, premium=self.premium,
        )
        start, end = pack.get("issued_at"), pack.get("expires_at")
        if (pack.get("kind") != "trial" or "license" in pack or "bundle_sha256" not in pack
                or type(start) is not int or type(end) is not int or start <= 0
                or end - start != TRIAL_DURATION or start > time.time() + TRIAL_CLOCK_TOLERANCE
                or set(pack["sheets"]) != self.private_sheets):
            raise ValueError("Invalid Master Keyboard trial")
        return pack

    def load_trial(self):
        try:
            with self.trial_file.open("rb") as stream:
                raw = stream.read(LIMIT * 2 + 1)
            if len(raw) > LIMIT * 2:
                raise ValueError("Trial file exceeds the download limit.")
            saved = json.loads(raw)
            if saved == {"used": True}:
                self.trial_state = "used"
                return
            self.use_trial_pack(self.read_trial(saved))
            self.expire_trial()
        except FileNotFoundError:
            pass
        except (OSError, ValueError, subprocess.SubprocessError):
            self.logger.warning("Saved Master Keyboard trial could not be verified.")

    def use_trial_pack(self, pack):
        remaining = min(TRIAL_DURATION, pack["expires_at"] - time.time())
        self.trial_deadline = time.monotonic() + remaining
        self.trial_pack = pack

    @property
    def trial_remaining(self):
        if self.trial_pack is None:
            return 0
        now = time.time()
        if now < self.trial_pack["issued_at"] - TRIAL_CLOCK_TOLERANCE:
            return 0
        return max(0, min(self.trial_pack["expires_at"] - now, self.trial_deadline - time.monotonic()))

    def expire_trial(self):
        if self.trial_pack is None or self.trial_remaining > 0:
            return False
        self.finish_trial()
        return True

    def finish_trial(self):
        """Keep the one-time marker and discard the downloaded theme bundle."""
        if self.trial_pack is None:
            return
        self.trial_pack = None
        self.trial_state = "used"
        try:
            self.save(self.trial_file, {"used": True})
        except OSError:
            self.logger.warning("Could not clear the Master Keyboard trial bundle.")

    def check_trial_status(self):
        if (not self.trial_supported or self.pack is not None or self.trial_remaining
                or self.trial_state == "used" or time.monotonic() < self.trial_status_retry_at
                or (self.trial_status_task is not None and not self.trial_status_task.done())):
            return
        self.trial_status_task = asyncio.create_task(self.refresh_trial_status(), name="Master Keyboard trial status")

    async def refresh_trial_status(self):
        state = None
        retry = 30
        try:
            async with aiohttp.ClientSession(headers=HTTP_HEADERS, timeout=aiohttp.ClientTimeout(total=5)) as session:
                async with session.post(self.store + "/api/trial/status",
                                        json={"device": self.device, **self.client},
                                        allow_redirects=False, ssl=self.https_context) as response:
                    if response.status == 200:
                        answer = await response_json(response, 4096)
                        if isinstance(answer, dict) and isinstance(remote_state := answer.get("state"), str):
                            state = {
                                "available": "available", "active": "resume", "used": "used", "paid": "unavailable",
                            }.get(remote_state)
                            if state is not None:
                                retry = 300
                    elif response.status == 404:
                        state, retry = "unavailable", 900
        except (aiohttp.ClientError, TimeoutError, OSError, ValueError):
            pass
        self.trial_status_retry_at = time.monotonic() + retry
        if state and self.pack is None and self.trial_pack is None and self.trial_state != "used":
            self.trial_state = state

    async def download_trial(self):
        if not self.trial_supported:
            return {"error": "The trial is unavailable in this installation."}
        try:
            async with aiohttp.ClientSession(headers=HTTP_HEADERS, timeout=aiohttp.ClientTimeout(total=20)) as session:
                async with session.post(self.store + "/api/trial/start",
                                        json={"device": self.device, **self.client},
                                        allow_redirects=False, ssl=self.https_context) as response:
                    if response.status == 410:
                        self.trial_state = "used"
                        return {"error": "This installation has already used its Premium trial."}
                    if response.status in (404, 409):
                        self.trial_state = "unavailable"
                        self.trial_status_retry_at = time.monotonic() + 900
                    if response.status != 200:
                        return {"error": {
                            404: "The Premium trial is currently unavailable.",
                            409: "A Premium purchase is already linked to this installation. Restore your purchase.",
                            429: "Too many attempts. Try again later.",
                        }.get(response.status, "Could not start the Premium trial. Try again.")}
                    envelope = await response_json(response, LIMIT * 2)
            pack = await asyncio.to_thread(self.read_trial, envelope)
            if pack["expires_at"] <= time.time():
                self.trial_state = "used"
                return {"error": "This installation has already used its Premium trial."}
            self.trial_state = "resume"
            return {"envelope": envelope, "pack": pack}
        except (aiohttp.ClientError, TimeoutError, OSError, ValueError, subprocess.SubprocessError):
            return {"error": "Could not load the Premium trial. Check your connection and try again."}

    @property
    def effective_pack(self):
        if self.pack is not None:
            return self.pack
        return self.trial_pack if self.trial_remaining else None

    @property
    def unlocked(self):
        pack = self.effective_pack
        return self.free | self.premium.intersection(pack["profiles"]) if pack else self.free

    def status(self):
        pending = bool(self.valid_checkout(self.checkout))
        checkout_url = f"{self.store}/checkout/device?id={self.checkout['id']}" if pending else None
        paid = self.pack is not None
        trial = not paid and self.trial_remaining > 0
        trial_state = self.trial_state
        if paid:
            trial_state = "unavailable"
        elif trial:
            trial_state = "active"
        elif self.trial_pack is not None:
            trial_state = "used"
        elif trial_state == "unavailable" and self.trial_status_task and not self.trial_status_task.done():
            trial_state = "checking"
        return {"public": True, "store": self.store, "active": paid or trial, "paid": paid,
                "trial_state": trial_state, "trial_expires_at": self.trial_pack["expires_at"] if trial else None,
                "plasma_install": isinstance(self.plasma, dict),
                "price": f"${LIFETIME_PRICE_USD} USD" if self.store else None,
                "pending": pending, "checkout_url": checkout_url, "locked": sorted(self.premium - self.unlocked),
                "renewing": self.renewal is not None}

    def preview(self, shape):
        if not isinstance(shape, str) or shape not in self.premium:
            raise ValueError("Choose a Premium theme to preview.")
        return "data:image/webp;base64," + base64.b64encode(
            (self.previews / f"{shape}.webp").read_bytes()
        ).decode("ascii")

    def clear_checkout(self):
        self.checkout = None
        try:
            self.checkout_file.unlink(missing_ok=True)
        except OSError:
            # The saved entitlement takes precedence at the next startup.
            pass

    async def begin_checkout(self):
        if not self.store:
            return {"error": "PayPal checkout and purchase recovery are coming soon."}
        if not self.device:
            return {"error": "The installation ID could not be read."}
        if self.pack is not None:
            return {"error": "Premium is already unlocked."}
        if not self.valid_checkout(self.checkout):
            try:
                async with aiohttp.ClientSession(headers=HTTP_HEADERS, timeout=aiohttp.ClientTimeout(total=10)) as session:
                    async with session.post(self.store + "/api/checkout/device", json={"device": self.device},
                                            allow_redirects=False, ssl=self.https_context) as response:
                        response.raise_for_status()
                        checkout = await response_json(response, 4096)
                if not self.valid_checkout(checkout):
                    raise ValueError("Unexpected checkout response")
                saved = {**checkout, "store": self.store, "device": self.device}
                self.save(self.checkout_file, saved)
                self.checkout = saved
            except (aiohttp.ClientError, TimeoutError, OSError, ValueError) as error:
                self.logger.warning("Could not start Master Keyboard checkout (%s).", type(error).__name__)
                return {"error": "Could not open a checkout. Try again."}
        access = self.status()
        return {"url": access["checkout_url"], "access": access}

    async def check_checkout(self, checkout):
        if not self.valid_checkout(checkout):
            return {"ended": True}
        try:
            async with aiohttp.ClientSession(headers=HTTP_HEADERS, timeout=aiohttp.ClientTimeout(total=15)) as session:
                async with session.post(self.store + "/api/checkout/claim",
                                        json={**{key: checkout[key] for key in ("id", "claim", "device")}, **self.client},
                                        allow_redirects=False, ssl=self.https_context) as response:
                    if response.status in (403, 404, 409, 410):
                        return {"ended": True}
                    if response.status == 202:
                        return None
                    if response.status == 200:
                        return await self.read_download(response)
        except (aiohttp.ClientError, TimeoutError, OSError, ValueError, subprocess.SubprocessError):
            pass
        return {"retry": True}

    async def refresh_saved_purchase(self):
        if self.renewal is None:
            return None
        try:
            async with aiohttp.ClientSession(headers=HTTP_HEADERS, timeout=aiohttp.ClientTimeout(total=15)) as session:
                async with session.post(self.store + "/api/licenses/refresh", json={**self.renewal, **self.client},
                                        allow_redirects=False, ssl=self.https_context) as response:
                    if response.status == 200:
                        result = await self.read_download(response)
                        if result["pack"].get("license") == self.pack.get("license"):
                            return result
        except (aiohttp.ClientError, TimeoutError, OSError, ValueError, subprocess.SubprocessError):
            pass
        return None

    async def refunded(self):
        """Ask the store whether this purchase was refunded or reversed.

        Only an explicit answer from the store counts. Being offline, a store
        outage or an unknown purchase all leave the saved purchase in place.
        """
        purchase = (self.pack or {}).get("license")
        if not self.store or not self.device or not isinstance(purchase, str) or not DEVICE.fullmatch(purchase):
            return False
        try:
            async with aiohttp.ClientSession(headers=HTTP_HEADERS, timeout=aiohttp.ClientTimeout(total=15)) as session:
                async with session.post(self.store + "/api/licenses/status",
                                        json={"license": purchase, "device": self.device},
                                        allow_redirects=False, ssl=self.https_context) as response:
                    if response.status != 200:
                        return False
                    answer = await response_json(response, 4096)
        except (aiohttp.ClientError, TimeoutError, OSError, ValueError):
            return False
        return isinstance(answer, dict) and answer.get("status") == "revoked"

    def forget_purchase(self):
        """Drop the saved purchase after the store reported a refund."""
        self.pack = None
        self.renewal = None
        try:
            self.entitlement_file.unlink(missing_ok=True)
        except OSError:
            self.logger.warning("Could not remove the refunded Master Keyboard purchase file.")

    async def support(self, email, message, version):
        """Send a Contact support message through the store."""
        if not self.store:
            return {"error": "Support messages are not available in this edition."}
        if not isinstance(email, str) or not re.fullmatch(r"[^@\s]{1,64}@[^@\s]+\.[A-Za-z]{2,63}", email.strip()):
            return {"error": "Enter the email address we should reply to."}
        if not isinstance(message, str) or not 5 <= len(message.strip()) <= 2000:
            return {"error": "Write a message of 5 to 2000 characters."}
        body = {"email": email.strip(), "message": message.strip(), "version": version}
        if self.device:
            body["device"] = self.device
        try:
            async with aiohttp.ClientSession(headers=HTTP_HEADERS, timeout=aiohttp.ClientTimeout(total=20)) as session:
                async with session.post(self.store + "/api/support", json=body,
                                        allow_redirects=False, ssl=self.https_context) as response:
                    if response.status == 204:
                        return {"sent": True}
                    return {"error": {
                        400: "Check your email address and message.",
                        429: "Too many messages. Try again in 15 minutes.",
                    }.get(response.status, "The message could not be sent. Try again later.")}
        except (aiohttp.ClientError, TimeoutError, OSError):
            return {"error": "The message could not be sent. Check your connection."}

    async def read_download(self, response):
        envelope = await response_json(response, LIMIT * 2)
        return {"envelope": envelope, "pack": await asyncio.to_thread(self.read_pack, envelope)}

    async def download(self, code):
        if not self.store:
            return {"error": "PayPal checkout and purchase recovery are coming soon."}
        if not self.device:
            return {"error": "The installation ID could not be read."}
        code = normalize_license(code)
        if not code or not LICENSE.fullmatch(code):
            return {"error": "Check the license key from your receipt. It looks like MK-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX."}
        try:
            async with aiohttp.ClientSession(headers=HTTP_HEADERS, timeout=aiohttp.ClientTimeout(total=20)) as session:
                async with session.post(self.store + "/api/licenses/activate",
                                        json={"license": code, "device": self.device, **self.client},
                                        allow_redirects=False, ssl=self.https_context) as response:
                    if response.status != 200:
                        return {"error": {
                            403: "This license is invalid or was refunded.",
                            409: "This license is active on another installation. Choose Recover by receipt email to move it here.",
                            429: "Too many attempts. Try again later.",
                        }.get(response.status, "The store is unavailable. Try again later.")}
                    return await self.read_download(response)
        except (aiohttp.ClientError, TimeoutError, OSError, ValueError, subprocess.SubprocessError):
            return {"error": "The theme download could not be verified. Update Master Keyboard, then try again."}
