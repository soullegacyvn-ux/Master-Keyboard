"""Install a verified stable Plasma release from the project's GitHub repository."""

import asyncio
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import tarfile
import tempfile

import aiohttp


REPOSITORY = "soullegacyvn-ux/Master-Keyboard-Plasma"
LATEST = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
DOWNLOAD = f"https://github.com/{REPOSITORY}/releases/download"
MAX_PACKAGE_BYTES = 32 * 1024 * 1024
MAX_METADATA_BYTES = 512 * 1024
VERSION = re.compile(r"(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}")
SHA256 = re.compile(r"[a-f0-9]{64}")
# These public installers predate VERSION. They install the settings program byte for byte.
LEGACY_SETTINGS = {
    "5d4ef8c26225745f969bfbc23af14208d8532624e97111a3cf40fcb10bcb023e": "1.0.0",
    "69714b9f751c0be1579f24fe3b31b064a4a227bf97aa93fc272be10325a77b14": "1.0.1",
    "96d779d216ecd06efd481ef581ac68ff662838edc523fbba5455d14f1d9f4b23": "1.0.2",
}


def version_key(value):
    if isinstance(value, str) and VERSION.fullmatch(value):
        return tuple(map(int, value.split(".")))
    return ()


@dataclass(frozen=True)
class PlasmaRelease:
    version: str
    digest: str

    @property
    def package(self):
        return f"master-keyboard-plasma-{self.version}"


def parse_release(metadata):
    if (not isinstance(metadata, dict) or metadata.get("draft") is not False
            or metadata.get("prerelease") is not False):
        raise ValueError("Expected a stable Plasma release.")
    tag = metadata.get("tag_name")
    assets = metadata.get("assets")
    if not isinstance(tag, str) or not tag.startswith("v") or not version_key(tag[1:]) or not isinstance(assets, list):
        raise ValueError("Invalid Plasma release metadata.")
    version = tag[1:]
    name = f"master-keyboard-plasma-{version}.tar.gz"
    matching = [asset for asset in assets if isinstance(asset, dict) and asset.get("name") == name]
    if len(matching) != 1:
        raise ValueError("The expected Plasma release archive is missing or ambiguous.")
    asset = matching[0]
    digest = asset.get("digest")
    size = asset.get("size")
    if (asset.get("state") != "uploaded" or type(size) is not int or not 0 < size <= MAX_PACKAGE_BYTES
            or not isinstance(digest, str) or not digest.startswith("sha256:")
            or not SHA256.fullmatch(digest[7:])):
        raise ValueError("The Plasma release archive has no valid verification information.")
    return PlasmaRelease(version, digest[7:])


def installed_version(theme):
    """Return the version, an empty string before install, or None if unidentified."""
    if not (theme / "launch").is_file():
        return ""
    try:
        with (theme / "VERSION").open(encoding="ascii") as stamp:
            value = stamp.read(32)
        if len(value) < 32 and version_key(value.strip()):
            return value.strip()
    except FileNotFoundError:
        try:
            with (theme / "masterkeyboard-settings").open("rb") as source:
                payload = source.read(128 * 1024 + 1)
            return LEGACY_SETTINGS.get(hashlib.sha256(payload).hexdigest())
        except OSError:
            pass
    except (OSError, UnicodeError):
        pass


def record_version(theme, version):
    # Releases through 1.0.2 did not bundle a version file.
    if (theme / "VERSION").is_file():
        return
    pending = tempfile.NamedTemporaryFile(mode="w", encoding="ascii", dir=theme, delete=False)
    path = Path(pending.name)
    try:
        with pending:
            pending.write(version + "\n")
        path.replace(theme / "VERSION")
    finally:
        path.unlink(missing_ok=True)


def extract(archive, destination, package):
    with tarfile.open(archive, "r:gz") as payload:
        members = payload.getmembers()
        total = 0
        seen = set()
        for member in members:
            path = PurePosixPath(member.name)
            if (not path.parts or path.parts[0] != package or ".." in path.parts
                    or path in seen or not (member.isdir() or member.isfile())):
                raise ValueError("Invalid file in the Plasma package.")
            seen.add(path)
            total += member.size
            if total > MAX_PACKAGE_BYTES or len(seen) > 512:
                raise ValueError("The Plasma package is too large.")
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as output, payload.extractfile(member) as source:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode & 0o755)
    source = destination / package / "install.sh"
    if not source.is_file():
        raise ValueError("The Plasma installer is missing.")
    return source


async def run_setup(script, home, user_id):
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{user_id}")
    environment = {"HOME": str(home), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
                   "MK_PLASMA_UPDATE": "1"}
    if runtime.is_absolute() and runtime.is_dir() and runtime.stat().st_uid == user_id:
        environment["XDG_RUNTIME_DIR"] = str(runtime)
        if (runtime / "bus").is_socket():
            environment["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={runtime / 'bus'}"
    process = await asyncio.create_subprocess_exec(
        "/bin/sh", str(script), env=environment, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        return await asyncio.wait_for(process.wait(), timeout=55) == 0
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()


class PlasmaInstaller:
    def __init__(self, release, https_context):
        self.pinned = PlasmaRelease(release.get("version"), release.get("sha256"))
        self.https_context = https_context
        self.lock = asyncio.Lock()

    async def latest(self, client):
        async with client.get(LATEST, ssl=self.https_context, allow_redirects=False,
                              headers={"Accept": "application/vnd.github+json", "User-Agent": "Master-Keyboard"},
                              timeout=aiohttp.ClientTimeout(total=12)) as response:
            response.raise_for_status()
            if response.status != 200:
                raise ValueError("Invalid Plasma release response.")
            body = bytearray()
            async for chunk in response.content.iter_chunked(16384):
                body.extend(chunk)
                if len(body) > MAX_METADATA_BYTES:
                    raise ValueError("Plasma release metadata is too large.")
        return parse_release(json.loads(body))

    async def download(self, client, archive, release):
        checksum = hashlib.sha256()
        size = 0
        url = f"{DOWNLOAD}/v{release.version}/{release.package}.tar.gz"
        async with client.get(url, ssl=self.https_context) as response:
            response.raise_for_status()
            with archive.open("xb") as stream:
                async for chunk in response.content.iter_chunked(64 * 1024):
                    size += len(chunk)
                    if size > MAX_PACKAGE_BYTES:
                        raise ValueError("The Plasma download is too large.")
                    checksum.update(chunk)
                    stream.write(chunk)
        if checksum.hexdigest() != release.digest:
            raise ValueError("The Plasma download did not match its checksum.")

    async def install(self):
        user_id = os.geteuid()
        if not user_id:
            return {"error": "Plasma setup needs to run as your normal Desktop user."}
        if not all(Path("/usr/bin", name).is_file() for name in ("plasma-keyboard", "kreadconfig6", "kwriteconfig6")):
            return {"error": "KDE Plasma 6 and its on-screen keyboard are required."}
        if not version_key(self.pinned.version) or not isinstance(self.pinned.digest, str) or not SHA256.fullmatch(self.pinned.digest):
            return {"error": "This release has invalid Plasma package information."}
        if self.lock.locked():
            return {"error": "Plasma setup is already running."}
        home = Path(pwd.getpwuid(user_id).pw_dir)
        theme = home / ".local/share/master-keyboard-plasma/masterkeyboard"
        async with self.lock:
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=50)) as client:
                    current = installed_version(theme)
                    if current is None:
                        return {"error": "Could not identify the installed Plasma version. Check the existing installation first."}
                    updated = bool(current)
                    try:
                        latest = await self.latest(client)
                    except (aiohttp.ClientError, TimeoutError):
                        if updated:
                            return {"error": "Could not check for a Plasma update. Try again."}
                        latest = self.pinned
                    except ValueError:
                        return {"error": "GitHub did not provide a verifiable Plasma release."}
                    if version_key(latest.version) <= version_key(self.pinned.version):
                        latest = self.pinned
                    current = installed_version(theme)
                    if version_key(current) >= version_key(latest.version):
                        return {"installed": True, "version": current, "already_current": True}
                    with tempfile.TemporaryDirectory(prefix="masterkeyboard-plasma-") as directory:
                        destination = Path(directory)
                        archive = destination / "package.tar.gz"
                        await self.download(client, archive, latest)
                        script = await asyncio.to_thread(extract, archive, destination, latest.package)
                        stamp = script.parent / "payload/VERSION"
                        if version_key(latest.version) > (1, 0, 2) and not stamp.is_file():
                            raise ValueError("The Plasma package version is missing.")
                        if stamp.is_file() and stamp.read_text(encoding="ascii").strip() != latest.version:
                            raise ValueError("The Plasma package version does not match the release.")
                        current = installed_version(theme)
                        if current is None:
                            return {"error": "The installed Plasma version could not be verified."}
                        if version_key(current) >= version_key(latest.version):
                            return {"installed": True, "version": current, "already_current": True}
                        if not await run_setup(script, home, user_id):
                            return {"error": "Setup failed. Check the KDE Plasma keyboard in Desktop Mode."}
                    if installed_version(theme) != latest.version:
                        return {"error": "Plasma setup did not report the expected version."}
                    try:
                        record_version(theme, latest.version)
                    except OSError:
                        return {"error": f"Plasma {latest.version} was installed, but its version could not be saved."}
            except (aiohttp.ClientError, TimeoutError):
                return {"error": "Could not complete the Plasma download or setup. Try again."}
            except (OSError, ValueError, tarfile.TarError):
                return {"error": "The Plasma package could not be verified or opened."}
        return {"installed": True, "version": latest.version, "updated": updated}
