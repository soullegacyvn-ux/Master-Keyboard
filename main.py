import asyncio
import fcntl
import hashlib
import json
import os
import pwd
import re
import sys
import tempfile
from time import monotonic
from contextlib import suppress
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import aiohttp
import decky


STEAM_TARGETS_URL = "http://127.0.0.1:8080/json/list"
STYLE_ID = "masterkeyboard-style"
POLL_INTERVAL = 3
CEF_CLOSE_TIMEOUT = 0.5
CEF_WS_TIMEOUT = (
    aiohttp.ClientWSTimeout(ws_close=CEF_CLOSE_TIMEOUT)
    if hasattr(aiohttp, "ClientWSTimeout")
    else CEF_CLOSE_TIMEOUT
)
HEIGHTS = (-20, -16, -12, -8, -4, 0, 4, 8)
SHAPES = json.loads((Path(__file__).parent / "assets/theme/profiles.json").read_text(encoding="utf-8"))
PLUGIN_NAME = json.loads((Path(__file__).parent / "plugin.json").read_text(encoding="utf-8"))["name"]
PLUGIN_VERSION = json.loads((Path(__file__).parent / "package.json").read_text(encoding="utf-8"))["version"]
UPDATE_CATALOG = "https://master-keyboard-decky-store.soullegacyvn.workers.dev/plugins/versions"
RELEASE_DOWNLOAD = "https://github.com/soullegacyvn-ux/Master-Keyboard/releases/download"
MAX_UPDATE_BYTES = 32 * 1024 * 1024
RETIRED_SHAPES = {
    "MT3": "MiamiAfterHours",
    "Low": "Sculpted", "Frosted": "Sculpted", "Bauhaus": "PastelPlush",
    "LilacSilicone": "PastelPlush", "Rally": "Translucent", "Obsidian": "SpectrumRGB",
}
LEGACY_COLOR_SETTINGS = {"Sculpted": "block_colors", "Square": "square_block_colors"}
TYPING_SOUNDS = ("Clicky", "Thock", "Soft", "Steam", "Off")
FOCUS_PALETTES = {
    "Purple": ("#c46fba", "#925088", "#b16ca4", "#692f60", "#f2b6e887", "#21151e", "#e0a9f0"),
    "Blue": ("#72b4f3", "#477eae", "#6a9ace", "#385d8e", "#bbdefb91", "#111f31", "#a5d5ff"),
    "Mint": ("#75ddbd", "#409d8d", "#60bda7", "#266a60", "#b5ffe297", "#132722", "#adf4d9"),
    "Amber": ("#f1bb65", "#b5803f", "#d39b59", "#8b5d2d", "#ffe0a497", "#302014", "#ffd694"),
    "Red": ("#ef8780", "#b34b48", "#c76b63", "#853d3a", "#ffc6be97", "#321817", "#ffb1a8"),
}
COLOR_BLOCKS = SHAPES["Sculpted"]["colors"].keys()
HEX_COLOR = re.compile(r"#[0-9A-Fa-f]{6}")
FOCUS_VARIABLES = ("face", "dark", "rim-light", "rim-dark", "highlight", "ink", "outline")
CHOICES = {
    "shape": SHAPES,
}
TYPING_SHORTCUTS = ("shift_double_tap_lock", "double_space_period", "sentence_capitalization")
DEFAULTS = {
    "enabled": False,
    "preview_open": False,
    "shape": "Sculpted",
    "height": -4,
    "transparent": False,
    "background_color": None,
    "background_transparency": None,
    "typing_sound": True,
    "typing_sound_style": None,
    "typing_preview": False,
    **dict.fromkeys(TYPING_SHORTCUTS, True),
    "focus_color": "Purple",
    "focus_brightness": 100,
    "focus_effect": "Fill",
    "block_colors": {},
    "square_block_colors": {},
    "style_block_colors": {},
    "wukong_block_brightness": {},
    "wukong_default_palette": None,
}
# Key colour schemes and custom key colours belong to Premium in the Public edition.
PREMIUM_COLOR_SETTINGS = ("block_colors", "square_block_colors", "style_block_colors",
                          "wukong_block_brightness", "wukong_default_palette")
LICENSE_CHECK_DELAY = 90
LICENSE_CHECK_INTERVAL = 24 * 60 * 60
GAMEPAD_TITLES = {"steam big picture mode", "steam virtual keyboard", "steam keyboard"}
CLASS_SELECTOR = re.compile(r"\.([a-zA-Z_-][a-zA-Z0-9_-]*)")


def release_version(version):
    match = re.fullmatch(r"(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z.-]+)?", version)
    if not match:
        raise ValueError("Invalid Master Keyboard version")
    return (*map(int, match.groups()[:3]), match[4] is None)


def valid_block_colors(colors):
    return isinstance(colors, dict) and all(
        block in COLOR_BLOCKS and isinstance(color, str) and HEX_COLOR.fullmatch(color)
        for block, color in colors.items()
    )


def valid_block_brightness(brightness):
    return isinstance(brightness, dict) and all(
        block in COLOR_BLOCKS and type(value) is int and 0 <= value <= 200
        for block, value in brightness.items()
    )


def validate_settings(settings):
    if not isinstance(settings, dict):
        raise ValueError("Masterkeyboard settings must be an object")
    # Ignore options saved by earlier Decky panels.
    settings = {key: value for key, value in settings.items()
                if key not in ("shift_animation", "shift_effect")}
    if isinstance(shape := settings.get("shape"), str) and shape in RETIRED_SHAPES:
        settings["shape"] = RETIRED_SHAPES[shape]
    if isinstance(overrides := settings.get("style_block_colors"), dict):
        settings["style_block_colors"] = {shape: colors for shape, colors in overrides.items() if shape not in RETIRED_SHAPES}
    for key, value in settings.items():
        if key not in DEFAULTS:
            raise ValueError(f"Unknown Masterkeyboard setting: {key}")
        if key in CHOICES:
            if not isinstance(value, str) or value not in CHOICES[key]:
                options = ", ".join(CHOICES[key])
                raise ValueError(f"Choose a supported {key}: {options}")
        elif key == "typing_sound_style":
            if value is not None and value not in TYPING_SOUNDS:
                raise ValueError("Choose a supported typing sound")
        elif key == "focus_color":
            if not isinstance(value, str) or (value not in FOCUS_PALETTES and not HEX_COLOR.fullmatch(value)):
                raise ValueError("Choose a focus preset or a six-digit hex color")
        elif key == "focus_brightness":
            if type(value) is not int or not 0 <= value <= 200:
                raise ValueError("Choose a focus brightness from 0 to 200")
        elif key == "focus_effect":
            if value not in ("Fill", "Outline", "Glow"):
                raise ValueError("Unknown focus effect")
        elif key == "height":
            if type(value) is not int or value not in HEIGHTS:
                raise ValueError("Choose a supported keyboard height")
        elif key == "background_color":
            if value is not None:
                if not isinstance(value, str) or not HEX_COLOR.fullmatch(value):
                    raise ValueError("Choose a six-digit hex color for the background")
                settings[key] = value.lower()
        elif key == "background_transparency":
            if value is not None and (type(value) is not int or not 0 <= value <= 100):
                raise ValueError("Choose a background transparency from 0 to 100")
        elif key in ("block_colors", "square_block_colors"):
            if not valid_block_colors(value):
                raise ValueError("Use a six-digit hex color for each key color block")
        elif key == "style_block_colors":
            if not isinstance(value, dict) or not all(
                shape in SHAPES and shape not in LEGACY_COLOR_SETTINGS and valid_block_colors(colors)
                for shape, colors in value.items()
            ):
                raise ValueError("Use a six-digit hex color for each style color block")
        elif key == "wukong_block_brightness":
            if not valid_block_brightness(value):
                raise ValueError("Choose a brightness from 0 to 200 for each Wukong color block")
        elif key == "wukong_default_palette":
            if value is not None and (
                not isinstance(value, dict) or set(value) != {"colors", "brightness"}
                or not valid_block_colors(value["colors"])
                or not valid_block_brightness(value["brightness"])
            ):
                raise ValueError("Use valid colors and brightness for the Wukong default palette")
        elif type(value) is not bool:
            raise ValueError(f"{key} must be a boolean")
    if "focus_effect" in settings:
        return {**settings, "focus_effect": "Fill"}
    return settings


KEY_FOCUS_QUERY = re.compile(r":not\(:has\((?:\[data-key\])?\[data-key-row\]\.gpfocus\)\)")
LAYOUT_QUERY = re.compile(
    r':has\(\s*(?:\[data-key="Masterkeyboard(Fn|ABC)"\]|'
    r':is\(\[data-key="MasterkeyboardFn"\],\s*\[data-key="MasterkeyboardABC"\]\))\s*\)'
)
CONTAINER_UNIT = re.compile(r"(?<![\w.+/=])(\d*\.?\d+)cqi\b")


def optimize_live_css(css):
    """Remove the two constructs that made Steam restyle every key on each press.

    Measured on a handheld with the Wukong theme, moving focus to another key
    cost about 28 ms of style work instead of 2 ms:

    * "keyboard:not(:has(key.gpfocus))" is re-evaluated for the whole keyboard
      whenever any key gains or loses focus. reference-layout.js mirrors that
      state in the data-mk-key-focus attribute on the keyboard instead.
    * A size container on the keyboard makes layout re-resolve every key's
      style. Steam's keyboard spans the window, so the container's inline size
      is the viewport width minus the keyboard's 4px of side padding.
    """
    css = KEY_FOCUS_QUERY.sub(":not([data-mk-key-focus])", css)
    css = LAYOUT_QUERY.sub(lambda match: {
        "Fn": '[data-mk-layout="typing"]',
        "ABC": '[data-mk-layout="fn"]',
        None: "[data-mk-layout]",
    }[match[1]], css)
    css = re.sub(r"container-type:\s*inline-size;", "", css)
    css = re.sub(r"container:\s*[\w-]+\s*/\s*inline-size;", "", css)
    css = re.sub(r"@container\s+[\w-]+\s*\(max-width:\s*(\d+)px\)",
                 lambda match: f"@media (max-width: {int(match[1]) + 4}px)", css)
    return CONTAINER_UNIT.sub(lambda match: f"calc((100vw - 4px) * {float(match[1]) / 100:g})", css)


def steam_socket(target, *, shared=False):
    """Limit changes to Steam's local UI pages."""
    if target.get("type") != "page":
        return None
    url = urlsplit(target.get("url", ""))
    local = (url.scheme == "about" and url.path == "blank") or (
        url.scheme in {"http", "https"} and url.hostname == "steamloopback.host"
    )
    if not local:
        return None

    agents = parse_qs(url.query).get("useragent", [])
    title = target.get("title", "").casefold()
    is_gamepad = any(agent.casefold().startswith("valve steam gamepad") for agent in agents)
    if shared:
        if title != "sharedjscontext":
            return None
    elif title == "sharedjscontext" or (not is_gamepad and title not in GAMEPAD_TITLES):
        return None

    socket = target.get("webSocketDebuggerUrl", "")
    address = urlsplit(socket)
    if (
        address.scheme == "ws"
        and address.hostname in {"127.0.0.1", "localhost", "::1"}
        and address.port == 8080
        and address.path.startswith("/devtools/page/")
    ):
        return socket
    return None


def rgb_channels(color):
    return tuple(int(color[index:index + 2], 16) for index in (1, 3, 5))


def mix_color(color, other, amount):
    components = zip(rgb_channels(color), rgb_channels(other), strict=True)
    return "#" + "".join(f"{int(base * (1 - amount) + tone * amount + 0.5):02x}" for base, tone in components)


def key_label_color(light_color, dark_color):
    # Pick the better contrast across both ends of the key face.
    def luminance(color):
        rgb = [channel / 255 for channel in rgb_channels(color)]
        linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in rgb]
        return sum(value * weight for value, weight in zip(linear, (0.2126, 0.7152, 0.0722), strict=True))

    light = luminance(light_color)
    dark = luminance(dark_color)
    return "#000000" if (dark + 0.05) / 0.05 >= 1.05 / (light + 0.05) else "#ffffff"


def focus_palette(color):
    dark = mix_color(color, "#171b1e", 0.2)
    ink = key_label_color(mix_color(color, "#fff8e8", 0.22), mix_color(dark, "#fff8e8", 0.18))
    return (
        color, dark, mix_color(color, "#171b1e", 0.15), mix_color(color, "#171b1e", 0.42),
        mix_color(color, "#fff8e8", 0.56) + "90", ink, mix_color(color, "#fff8e8", 0.45),
    )


def profile_block_rules(palette, aliases, *, tint_artwork=False):
    keyboard = ".DefaultTheme." + aliases["virtualkeyboard_Keyboard_45rH7"]
    cap = "." + aliases["virtualkeyboard_KeyboardKey_2KhPX"]

    def rule(hit, block):
        tint = f" --mk-style-art-tint: var(--mk-style-{block}-art-tint);" if tint_artwork else ""
        return (
            f"{keyboard} {hit} > {cap} {{"
            f" --mk-style-color: var(--mk-style-{block});"
            f" --retro-ink: var(--mk-style-{block}-ink);{tint} }}"
        )

    rules = [rule("[data-key-row]", "cream")]
    for block, spec in palette.items():
        if rows := spec.get("rows"):
            hit = ", ".join(f'[data-key-row="{row}"]' for row in rows)
            rules.append(rule(f":is({hit})", block))
    for block, spec in palette.items():
        if keys := spec.get("keys"):
            if "VKClose" in keys and "VKMove" not in keys:
                keys = [*keys, "VKMove"]
            if "VKPaste" in keys:
                keys = [*keys, "MasterkeyboardCut", "MasterkeyboardCopy", "MasterkeyboardPaste", "MasterkeyboardSelectAll"]
            hit = ", ".join(f"[data-key={json.dumps(key, ensure_ascii=False)} i]" for key in keys)
            rules.append(rule(f":is({hit})", block))
    return "\n".join(rules)


def unified_preview(template):
    # Replace the first two keys and leave Space and the Steam controls intact.
    row = re.search(r'(?m)^<div class="mk-preview-row Row_4".*$', template)
    if not row:
        return template
    space = re.search(r'<div class="mk-preview-hit[^>]* data-key=" ".*?(?=<div class="mk-preview-hit)', row[0])
    if not space:
        return template

    def cap(key, label):
        return (
            '<div class="mk-preview-hit _1YqjVUO3KYLRq_mer-HsUX" '
            f'data-key="Masterkeyboard{key}" data-key-row="4" style="--mk-preview-weight:1">'
            f'<div class="mk-preview-cap _2KhPXikozxMpbIRo_6jPxW"><span>{label}</span></div></div>'
        )

    ctrl, fn, alt = cap("Ctrl", "Ctrl"), cap("Fn", "Fn"), cap("Alt", "Alt")
    bottom = f'<div class="mk-preview-row Row_4">{ctrl}{alt}{fn}{row[0][space.start():]}'
    return template[:row.start()] + bottom + template[row.end():]


class Theme:
    def __init__(self, folder, available=None, downloaded=None, *, local_wukong_art=None):
        aliases = json.loads((folder / "class-aliases.json").read_text(encoding="utf-8"))
        self.profiles = SHAPES if available is None else {shape: SHAPES[shape] for shape in available}
        downloaded = downloaded or {}
        files = {
            "keys.css", "unified-layout.css", "transparent.css", "background-color.css",
            "control-accents.css", "focus-fill.css",
        }
        if (folder / "focus.css").is_file():
            files.add("focus.css")
        for profile in self.profiles.values():
            files.update(profile["sheets"])
        sources = {
            name: downloaded[name] if name in downloaded else (folder / name).read_text(encoding="utf-8")
            for name in sorted(files)
        }
        if "Wukong" in self.profiles:
            # Cap geometry ships with the client so an older cached purchase
            # supplies the artwork without restoring the older key silhouette.
            for name in ("wukong-console-shape.css", "wukong-engraving.css"):
                with suppress(OSError, UnicodeError):
                    sources[name] = (folder / name).read_text(encoding="utf-8")
            local_wukong_art = local_wukong_art or folder / "wukong-local-art.css"
            with suppress(OSError, UnicodeError):
                sources["wukong-local-art.css"] = local_wukong_art.read_text(encoding="utf-8")
        self.sheets = {
            name: CLASS_SELECTOR.sub(lambda match: "." + aliases.get(match[1], match[1]), css)
            for name, css in sources.items()
        }
        self.profile_rules = {
            shape: profile_block_rules(
                profile["colors"], aliases, tint_artwork=profile.get("tint_artwork", False)
            )
            for shape, profile in self.profiles.items()
            if shape not in LEGACY_COLOR_SETTINGS and not profile.get("legacy_color_layout")
        }
        self.preview_template = unified_preview((folder / "preview.html").read_text(encoding="utf-8"))

    def render_css(self, settings):
        shape = settings["shape"]
        profile = self.profiles[shape]
        names = ["keys.css", *profile["sheets"], "unified-layout.css"]
        if shape == "Wukong":
            engraving = "wukong-local-art.css" if "wukong-local-art.css" in self.sheets else "wukong-engraving.css"
            if engraving in self.sheets:
                names.append(engraving)
        transparency = settings["background_transparency"]
        if transparency is None:
            transparency = 50 if settings["transparent"] else 0
        if transparency:
            names.append("transparent.css")
        background_color = settings.get("background_color")
        if background_color is not None:
            names.append("background-color.css")
        if "focus.css" in self.sheets:
            names.append("focus.css")
        sheets = [self.sheets[name] for name in names]
        if shape in self.profile_rules:
            sheets.append(self.profile_rules[shape])
        sheets.append(self.sheets["control-accents.css"])
        sheets.append(self.sheets["focus-fill.css"])
        css = "\n".join(sheets)
        focus_color = settings["focus_color"]
        preset = FOCUS_PALETTES.get(focus_color)
        brightness = settings["focus_brightness"]
        custom_focus = preset is None or brightness != 100
        if custom_focus:
            base = preset[0] if preset else focus_color
            target = "#000000" if brightness < 100 else "#ffffff"
            adjusted = mix_color(base, target, abs(brightness - 100) / 100)
            colors = focus_palette(adjusted)
        else:
            colors = preset
        variables = [f"  --retro-height-offset: {settings['height']}px;"]
        if transparency:
            variables.append(f"  --mk-background-opacity: {100 - transparency}%;")
        if background_color is not None:
            red, green, blue = rgb_channels(background_color)
            variables.append(f"  --mk-custom-background-rgb: {red} {green} {blue};")
        variables.extend(
            f"  --mk-focus-{name}: {value};"
            for name, value in zip(FOCUS_VARIABLES, colors, strict=True)
        )
        if custom_focus:
            variables.append("  --mk-custom-focus-ink: var(--mk-focus-ink);")
        legacy_setting = LEGACY_COLOR_SETTINGS.get(shape)
        if legacy_setting or profile.get("legacy_color_layout"):
            overrides = settings[legacy_setting] if legacy_setting else settings["style_block_colors"].get(shape, {})
            for block, color in sorted(overrides.items()):
                original = profile["colors"][block]["color"]
                if color.casefold() == original.casefold():
                    continue
                variables.append(f"  --mk-custom-{block}: {color};")
                channel_distance = max(abs(a - b) for a, b in zip(rgb_channels(color), rgb_channels(original), strict=True))
                # Keep the vintage lettering for small tints of the original palette.
                if channel_distance > 16:
                    ink = key_label_color(color, mix_color(color, "#10121b", 0.22))
                    variables.append(f"  --mk-custom-{block}-ink: {ink};")
                    if block == "cream" and ink == "#ffffff":
                        variables.append("  --mk-legacy-caps-filter: brightness(0) invert(1);")
        else:
            variables.append(f"  --mk-profile-height: {profile['height']}px;")
            overrides = settings["style_block_colors"].get(shape, {})
            brightness_by_block = settings["wukong_block_brightness"] if shape == "Wukong" else {}
            for block, spec in profile["colors"].items():
                color = overrides.get(block, spec["color"])
                brightness = brightness_by_block.get(block, 100)
                if brightness != 100:
                    target = "#000000" if brightness < 100 else "#ffffff"
                    color = mix_color(color, target, abs(brightness - 100) / 100)
                uses_default = color.casefold() == spec["color"].casefold()
                ink = spec.get("ink") if uses_default else None
                if ink is None:
                    ink = key_label_color(color, mix_color(color, "#10121b", 0.18))
                variables.append(f"  --mk-style-{block}: {color};")
                variables.append(f"  --mk-style-{block}-ink: {ink};")
                if profile.get("tint_artwork"):
                    tint = "transparent" if uses_default else f"color-mix(in srgb, {color} 82%, transparent)"
                    variables.append(f"  --mk-style-{block}-art-tint: {tint};")
                    if shape == "Wukong" and block == "blue" and not uses_default:
                        variables.append(f"  --mk-wukong-modifier-color: {color};")
                        variables.append(f"  --mk-wukong-modifier-ink: {ink};")
                        variables.append(f"  --mk-wukong-modifier-tint: {tint};")
        accents = (
            ("caps", "red", "#743d3a" if shape == "Wukong" else "#a24647", "#f7dca3" if shape == "Wukong" else "#fff4de"),
            ("shift", "gold", "#cda35d" if shape == "Wukong" else "#e3c067", "#2c210e"),
        )
        for name, block, default, default_ink in accents:
            color = overrides.get(block, default)
            uses_default = color.casefold() in (default, profile["colors"][block]["color"].casefold())
            color = default if uses_default else color
            ink = default_ink if uses_default else key_label_color(color, mix_color(color, "#10121b", 0.18))
            variables.append(f"  --mk-control-{name}: {color};")
            variables.append(f"  --mk-control-{name}-ink: {ink};")
            if profile.get("tint_artwork") and not uses_default:
                variables.append(f"  --mk-control-{name}-tint: color-mix(in srgb, {color} 82%, transparent);")
        return css + "\n:root {\n" + "\n".join(variables) + "\n}\n"

    def stylesheet(self, settings):
        if not settings["enabled"]:
            return "", ""
        css = optimize_live_css(self.render_css(settings))
        return css, hashlib.sha256(css.encode()).hexdigest()

    def preview(self, settings, show_focus=True):
        row_height = self.profiles[settings["shape"]]["height"]
        full_height = 5 * (row_height + settings["height"]) + 4
        return self.preview_template.replace(
            "__MASTERKEYBOARD_HEIGHT__", str(full_height)
        ).replace("__MASTERKEYBOARD_STYLE__", self.render_css(settings)).replace(
            "__MASTERKEYBOARD_PREVIEW_FOCUS__", " gpfocus" if show_focus else ""
        )


async def evaluate(socket, request_id, expression):
    await socket.send_json({
        "id": request_id,
        "method": "Runtime.evaluate",
        "params": {"expression": expression, "returnByValue": True},
    })
    async with asyncio.timeout(2):
        async for message in socket:
            if message.type != aiohttp.WSMsgType.TEXT:
                continue
            payload = message.json()
            if payload.get("id") != request_id:
                continue
            packet = payload.get("result", {})
            if "error" in payload or "exceptionDetails" in packet:
                raise RuntimeError("Steam refused a Masterkeyboard style update")
            return packet.get("result", {}).get("value")
    raise RuntimeError("Steam closed the Masterkeyboard styling connection")


TYPING_TOUCH_SETUP = r"""(enabled => {
    const key = Symbol.for("masterkeyboard.touchTypingSound");
    const onSteamOS = new URLSearchParams(location.search).get("IS_STEAMOS") === "true";
    const current = globalThis[key];
    if (current && (!enabled || !onSteamOS || current.version !== 2)) {
        document.removeEventListener("touchstart", current, true);
        document.removeEventListener("touchend", current, true);
        delete globalThis[key];
    }
    if (!enabled || !onSteamOS || globalThis[key]) return;

    const playTouch = event => {
        if (!event.isTrusted) return;
        const hit = event.target?.closest?.("[data-key-row][data-key]");
        if (!hit?.closest('[role="grid"].DefaultTheme')) return;
        // SteamOS uses haptics instead of the native typing sound on touch.
        try {
            const sound = opener?.[Symbol.for("masterkeyboard.typingSound")];
            const audio = opener?.SteamUIStore?.GamepadUIAudio;
            if (!sound?.active || sound.preset === "Off" || !audio) return;
            const released = Date.now();
            setTimeout(() => {
                if (sound.active && sound.lastRequest < released - 45) {
                    audio.PlayNavSound(26, true);
                }
            }, 28);
        } catch {
            // Some Steam views do not have access to the shared window.
        }
    };
    playTouch.version = 2;
    globalThis[key] = playTouch;
    document.addEventListener("touchend", playTouch, { capture: true, passive: true });
})"""


async def style_page(client, url, css, revision, typing_sound, reference_script, reference_revision, typing_shortcuts):
    style_id = json.dumps(STYLE_ID)
    version = json.dumps(revision)
    touch = json.dumps(bool(revision) and typing_sound)
    mode = json.dumps("qwerty" if revision else None)
    layout_revision = json.dumps(reference_revision if revision else None)
    typing_preview = json.dumps(bool(revision) and reference_revision.endswith("+preview"))
    shortcuts = json.dumps(typing_shortcuts)
    async with client.ws_connect(url, timeout=CEF_WS_TIMEOUT) as socket:
        probe = f"""(() => {{
            const onSteamOS = new URLSearchParams(location.search).get("IS_STEAMOS") === "true";
            const listener = globalThis[Symbol.for("masterkeyboard.touchTypingSound")];
            const desiredTouch = {touch} && onSteamOS;
            const touchReady = desiredTouch ? listener?.version === 2 : !listener;
            const current = document.getElementById({style_id})?.dataset.revision ?? "";
            const reference = globalThis[Symbol.for("masterkeyboard.referenceLayout")];
            const layoutReady = (reference?.mode ?? null) === {mode} && (reference?.revision ?? null) === {layout_revision};
            const typingReady = !{mode} || Object.entries({shortcuts}).every(
                ([name, value]) => reference?.typingSettings?.[name] === value);
            return [current === {version}, touchReady, layoutReady, typingReady];
        }})()"""
        style_ready, touch_ready, layout_ready, typing_ready = await evaluate(socket, 1, probe)
        if style_ready and touch_ready and layout_ready and typing_ready:
            return
        reference_update = ""
        if not layout_ready:
            reference_update = f"{reference_script}({mode}, {layout_revision}, {typing_preview}, {shortcuts});"
        elif not typing_ready:
            reference_update = f'globalThis[Symbol.for("masterkeyboard.referenceLayout")]?.setTypingSettings({shortcuts});'
        contents = json.dumps(None if style_ready else css)
        await evaluate(socket, 2, f"""(() => {{
            {TYPING_TOUCH_SETUP}({touch});
            {reference_update}
            const styles = {contents};
            if (styles === null) return;
            const existing = document.getElementById({style_id});
            if (!{version}) {{
                existing?.remove();
                return;
            }}
            if (!document.head || existing?.dataset.revision === {version}) return;
            const style = existing || document.createElement("style");
            style.id = {style_id};
            style.textContent = styles;
            style.dataset.revision = {version};
            if (!style.isConnected) document.head.appendChild(style);
        }})()""")


TYPING_SOUND_SETUP = r"""(preset => {
    const key = Symbol.for("masterkeyboard.typingSound");
    const current = globalThis[key];
    const manager = globalThis.SteamUIStore?.GamepadUIAudio?.AudioPlaybackManager;
    if (preset && current?.manager === manager && current?.active && current.preset === preset) return;
    if (current) {
        current.active = false;
        if (current.manager.PlayAudioURL === current.play) {
            if (current.ownPlay) {
                Object.defineProperty(current.manager, "PlayAudioURL", current.ownPlay);
            } else {
                delete current.manager.PlayAudioURL;
            }
        }
        delete globalThis[key];
    }
    if (!preset || typeof manager?.PlayAudioURL !== "function") return;

    const settings = {
        manager,
        active: true,
        preset,
        lastRequest: 0,
        ownPlay: Object.getOwnPropertyDescriptor(manager, "PlayAudioURL"),
    };
    const original = manager.PlayAudioURL;
    const buffers = new WeakMap();

    const profiles = {
        Clicky: { duration: .073, tone: 1780, noise: .62, edge: .62, decay: 210, peak: .88 },
        Thock: { duration: .092, tone: 400, noise: .34, edge: -.38, decay: 115, peak: .81 },
        Soft: { duration: .048, tone: 1080, noise: .30, edge: -.27, decay: 275, peak: .56 },
    };

    function clickBuffer(context) {
        const profile = profiles[preset];
        const saved = buffers.get(context);
        if (saved) return saved;
        const rate = context.sampleRate;
        const buffer = context.createBuffer(1, Math.round(rate * profile.duration), rate);
        const samples = buffer.getChannelData(0);
        let random = 0x734d3d57;
        let previous = 0;
        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
            const time = i / rate;
            random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
            const noise = random / 2147483648 - 1;
            const snap = noise - previous * profile.edge;
            previous = noise;
            const attack = Math.min(1, time / 0.0004) * Math.exp(-time * profile.decay);
            const body = Math.sin(2 * Math.PI * profile.tone * time) * Math.exp(-time * 300);
            const release = time > 0.022 ? Math.exp(-(time - 0.022) * 390) : 0;
            const value = (profile.noise * snap + 0.29 * body) * attack + 0.10 * snap * release;
            samples[i] = value;
            peak = Math.max(peak, Math.abs(value));
        }
        for (let i = 0; i < samples.length; i++) samples[i] *= profile.peak / peak;
        buffers.set(context, buffer);
        return buffer;
    }

    settings.play = function(url, ...args) {
        if (url !== "/sounds/deck_ui_typing.wav" || !settings.active) {
            return original.call(this, url, ...args);
        }
        settings.lastRequest = Date.now();
        if (preset === "Off") return;
        const playback = original.call(this, url, ...args);
        if (preset === "Steam" || typeof playback?.PlayBuffer !== "function") return playback;
        const playBuffer = playback.PlayBuffer;
        playback.PlayBuffer = function(buffer, destination) {
            const context = manager.context;
            return playBuffer.call(this, settings.active && context ? clickBuffer(context) : buffer, destination);
        };
        return playback;
    };
    manager.PlayAudioURL = settings.play;
    globalThis[key] = settings;
})"""


PASTE_SETUP = r"""((enabled, plugin) => {
    const key = Symbol.for("masterkeyboard.gamescopePaste");
    const current = globalThis[key];
    const manager = globalThis.SteamUIStore?.WindowStore?.GamepadUIMainWindowInstance?.VirtualKeyboardManager;
    if (enabled && current?.manager === manager && current?.plugin === plugin) return;
    if (current) {
        if (current.manager.SendClientPasteCommand === current.send) {
            if (current.ownSend) {
                Object.defineProperty(current.manager, "SendClientPasteCommand", current.ownSend);
            } else {
                delete current.manager.SendClientPasteCommand;
            }
        }
        delete globalThis[key];
    }
    if (!enabled || typeof manager?.SendClientPasteCommand !== "function" || !globalThis.DeckyBackend) return;
    const original = manager.SendClientPasteCommand;
    const ownSend = Object.getOwnPropertyDescriptor(manager, "SendClientPasteCommand");
    const paste = DeckyBackend.callable("loader/call_plugin_method");
    const send = function() {
        void paste(plugin, "paste_gamescope_codex").then(
            handled => { if (!handled) original.call(this); },
            () => original.call(this),
        );
    };
    manager.SendClientPasteCommand = send;
    globalThis[key] = { manager, send, ownSend, plugin };
})"""


async def shared_page(client, url, preset):
    desired_preset = json.dumps(preset)
    enabled = json.dumps(preset is not None)
    async with client.ws_connect(url, timeout=CEF_WS_TIMEOUT) as socket:
        probe = f"""(() => {{
            const preset = {desired_preset};
            const audio = globalThis.SteamUIStore?.GamepadUIAudio?.AudioPlaybackManager;
            const sound = globalThis[Symbol.for("masterkeyboard.typingSound")];
            const soundReady = sound ? !!preset && sound.manager === audio && sound.active && sound.preset === preset
              : !preset || typeof audio?.PlayAudioURL !== "function";
            const keyboard = globalThis.SteamUIStore?.WindowStore?.GamepadUIMainWindowInstance?.VirtualKeyboardManager;
            const paste = globalThis[Symbol.for("masterkeyboard.gamescopePaste")];
            const pasteReady = paste ? {enabled} && paste.manager === keyboard && paste.plugin === {json.dumps(PLUGIN_NAME)}
              : !{enabled} || typeof keyboard?.SendClientPasteCommand !== "function" || !globalThis.DeckyBackend;
            return soundReady && pasteReady;
        }})()"""
        if await evaluate(socket, 1, probe):
            return
        expression = f"{TYPING_SOUND_SETUP}({desired_preset}); {PASTE_SETUP}({enabled}, {json.dumps(PLUGIN_NAME)})"
        await evaluate(socket, 2, expression)


def write_settings(path, settings):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=".settings-", delete=False
    ) as stream:
        temp = Path(stream.name)
        try:
            json.dump(settings, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    try:
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def allow_decky_shutdown():
    # Decky 3.3.1 loops at EOF on its plugin socket (Decky Loader #975).
    # Install this guard inside the Master Keyboard process only.
    if os.environ.get("DECKY_VERSION", "").removeprefix("v") != "3.3.1":
        return
    socket_module = sys.modules.get("decky_loader.localplatform.localsocket")
    if socket_module is None:
        return
    socket_class = socket_module.UnixSocket
    read_line = socket_class._read_single_line
    listen = socket_class._listen_for_method_call

    class DeckySocketClosed(Exception):
        pass

    async def read_connected_line(socket, reader):
        line = await read_line(socket, reader)
        if not line and reader.at_eof():
            raise DeckySocketClosed
        return line

    async def listen_until_closed(socket, reader, writer):
        try:
            await listen(socket, reader, writer)
        except DeckySocketClosed:
            writer.close()

    socket_class._read_single_line = read_connected_line
    socket_class._listen_for_method_call = listen_until_closed


class Plugin:
    async def _main(self):
        allow_decky_shutdown()
        self.settings_path = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "settings.json"
        self.local_wukong_art = self.settings_path.with_name("wukong-local-art.css")
        self.settings = dict(DEFAULTS)
        try:
            stored = json.loads(self.settings_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            decky.logger.warning("Could not read Masterkeyboard settings. Using defaults.")
        else:
            try:
                self.settings.update(validate_settings(stored))
            except ValueError as error:
                decky.logger.warning("Invalid Masterkeyboard settings: %s", error)
        assets = Path(decky.DECKY_PLUGIN_DIR) / "assets"
        self.theme_dir = assets / "theme"
        self.public = None
        self.plasma_installer = None
        if (assets / "commerce.json").is_file():
            from public_access import PublicAccess
            self.public = PublicAccess(assets, self.settings_path.parent, SHAPES, write_settings, decky.logger)
        if self.public:
            if isinstance(self.public.plasma, dict):
                from plasma_install import PlasmaInstaller
                self.plasma_installer = PlasmaInstaller(self.public.plasma, self.public.https_context)
            self.update_lock = asyncio.Lock()
            self.update_cache = (0, None)
            for archive in self.settings_path.parent.glob("update-*.zip"):
                version = archive.name.removeprefix("update-").split("_", 1)[0]
                with suppress(OSError, ValueError):
                    if release_version(version) <= release_version(PLUGIN_VERSION):
                        archive.unlink()
            self.theme = Theme(self.theme_dir, self.public.unlocked, (self.public.pack or {}).get("sheets"),
                               local_wukong_art=self.local_wukong_art)
        else:
            self.theme = Theme(self.theme_dir, local_wukong_art=self.local_wukong_art)
        self.render_lock = None
        if self.settings["enabled"] and not self.acquire_renderer():
            self.settings["enabled"] = False
        self.reference_script = (assets / "reference-layout.js").read_text(encoding="utf-8").replace(
            '"__MK_BACKEND_NAME__"', json.dumps(PLUGIN_NAME))
        self.reference_revision = hashlib.sha256(self.reference_script.encode()).hexdigest()
        self.desired = self.theme.stylesheet(self.live_settings())
        self.change = asyncio.Event()
        self.error = None
        self.editor_action_lock = asyncio.Lock()
        self.worker = asyncio.create_task(self.watch(), name="Masterkeyboard Steam styling")
        self.checkout_change = asyncio.Event()
        self.checkout_worker = (
            asyncio.create_task(self.watch_checkout(), name="Master Keyboard checkout")
            if self.public and self.public.store else None
        )
        self.license_worker = (
            asyncio.create_task(self.watch_license(), name="Master Keyboard license")
            if self.public and self.public.store else None
        )

    async def _unload(self):
        self.worker.cancel()
        workers = [self.worker]
        if self.checkout_worker is not None:
            self.checkout_worker.cancel()
            workers.append(self.checkout_worker)
        if self.license_worker is not None:
            self.license_worker.cancel()
            workers.append(self.license_worker)
        # Decky allows five seconds for the process to exit.
        try:
            with suppress(TimeoutError):
                async with asyncio.timeout(2.5):
                    await asyncio.gather(*workers, return_exceptions=True)
                    if self.render_lock is not None:
                        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3)) as client:
                            await self.reconcile(client, "", "")
        finally:
            if self.render_lock is not None:
                self.release_renderer()

    def acquire_renderer(self):
        if self.render_lock is not None:
            return True
        lock = (self.settings_path.parent.parent / ".masterkeyboard-render.lock").open("a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            return False
        except OSError:
            lock.close()
            raise
        self.render_lock = lock
        return True

    def release_renderer(self):
        self.render_lock.close()
        self.render_lock = None

    @property
    def colors_locked(self):
        return bool(self.public and self.public.pack is None)

    def live_settings(self, settings=None):
        settings = self.settings if settings is None else settings
        if self.public and settings["shape"] not in self.public.unlocked:
            settings = {**settings, "shape": self.public.fallback}
        if self.colors_locked:
            # The saved colours stay on disk and come back when Premium is unlocked.
            settings = {**settings, **{key: DEFAULTS[key] for key in PREMIUM_COLOR_SETTINGS}}
        return settings

    async def get_access(self):
        if not self.public:
            return {"public": False, "store": None, "active": False, "pending": False, "locked": [],
                    "colors_locked": False}
        return {**self.public.status(), "colors_locked": self.colors_locked}

    async def install_plasma(self):
        if self.plasma_installer is None:
            return {"error": "Plasma setup is unavailable in this edition."}
        return await self.plasma_installer.install()

    async def check_update(self, refresh=False):
        if not self.public:
            return None
        async with self.update_lock:
            expires, candidate = self.update_cache
            if not refresh and monotonic() < expires:
                return candidate
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as client:
                async with client.get(UPDATE_CATALOG, ssl=self.public.https_context, allow_redirects=False) as response:
                    response.raise_for_status()
                    version, digest, artifact = (await response.json())[PLUGIN_NAME]
            expected_url = f"{RELEASE_DOWNLOAD}/v{version}/Master-Keyboard-{version}.zip"
            latest = release_version(version)
            if not latest[-1] or artifact != expected_url or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("Invalid Master Keyboard update metadata")
            candidate = {"version": version, "hash": digest, "artifact": artifact} if latest > release_version(PLUGIN_VERSION) else None
            self.update_cache = (monotonic() + 4 * 60 * 60, candidate)
            return candidate

    async def prepare_update(self, version):
        candidate = await self.check_update()
        if not candidate or candidate["version"] != version:
            raise ValueError("Check for the latest Master Keyboard update again")
        digest = candidate["hash"]
        folder = self.settings_path.parent
        folder.mkdir(parents=True, exist_ok=True)
        archive = folder / f"update-{version}_{digest}.zip"
        checksum = hashlib.sha256()
        size = 0
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=folder, delete=False) as download:
                temporary = Path(download.name)
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=45)) as client:
                    async with client.get(candidate["artifact"], ssl=self.public.https_context) as response:
                        response.raise_for_status()
                        async for chunk in response.content.iter_chunked(64 * 1024):
                            size += len(chunk)
                            if size > MAX_UPDATE_BYTES:
                                raise ValueError("Master Keyboard update exceeds the download limit")
                            download.write(chunk)
                            checksum.update(chunk)
            if checksum.hexdigest() != digest:
                raise ValueError("Master Keyboard update failed its checksum")
            temporary.replace(archive)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        # Decky opens the path after file:// directly, including spaces in the settings directory.
        return {"artifact": f"file://{archive}", "hash": digest}

    async def get_premium_preview(self, shape):
        if self.public:
            return self.public.preview(shape)
        raise ValueError("Premium previews are part of the Public edition.")

    async def activate_purchase(self, code):
        if not self.public:
            return {"error": "Purchase activation is part of the Public edition."}
        async with self.public.activation_lock:
            result = await self.public.download(code)
            if "error" in result:
                return result
            self.install_entitlement(result)
            return {"access": await self.get_access(), "settings": self.live_settings()}

    async def send_support(self, email, message):
        if not self.public:
            return {"error": "Support messages are part of the Public edition."}
        return await self.public.support(email, message, PLUGIN_VERSION)

    async def begin_checkout(self):
        if not self.public:
            return {"error": "Checkout is part of the Public edition."}
        async with self.public.activation_lock:
            result = await self.public.begin_checkout()
            if "access" in result:
                result["access"] = {**result["access"], "colors_locked": self.colors_locked}
            if "url" in result:
                self.checkout_change.set()
            return result

    def install_entitlement(self, result):
        theme = Theme(self.theme_dir, SHAPES, result["pack"]["sheets"], local_wukong_art=self.local_wukong_art)
        desired = theme.stylesheet(self.settings)
        write_settings(self.public.entitlement_file, result["envelope"])
        self.public.pack = result["pack"]
        self.public.renewal = None
        self.public.clear_checkout()
        self.theme = theme
        self.desired = desired
        self.change.set()
        self.checkout_change.set()

    def remove_entitlement(self):
        self.public.forget_purchase()
        self.theme = Theme(self.theme_dir, self.public.unlocked, None, local_wukong_art=self.local_wukong_art)
        self.desired = self.theme.stylesheet(self.live_settings())
        self.change.set()
        self.checkout_change.set()

    async def watch_license(self):
        """Refresh a previous edition's bundle and check for explicit refunds."""
        if self.public.renewal is None:
            await asyncio.sleep(LICENSE_CHECK_DELAY)
        while True:
            if self.public.renewal is not None:
                async with self.public.activation_lock:
                    result = await self.public.refresh_saved_purchase()
                    if result:
                        try:
                            self.install_entitlement(result)
                        except (OSError, ValueError):
                            decky.logger.warning("Could not save the updated Master Keyboard collection.")
            if self.public.pack is not None and await self.public.refunded():
                async with self.public.activation_lock:
                    if self.public.pack is not None:
                        decky.logger.warning("The Master Keyboard purchase was refunded. Premium is locked again.")
                        self.remove_entitlement()
            await asyncio.sleep(120 if self.public.renewal is not None else LICENSE_CHECK_INTERVAL)

    async def watch_checkout(self):
        while True:
            self.checkout_change.clear()
            checkout = self.public.checkout
            if checkout is None:
                await self.checkout_change.wait()
                continue
            result = await self.public.check_checkout(checkout)
            delay = 3 if result is None else 12
            async with self.public.activation_lock:
                if self.public.checkout is not checkout:
                    continue
                if result and result.get("ended"):
                    self.public.clear_checkout()
                    continue
                if result and "pack" in result:
                    try:
                        self.install_entitlement(result)
                        continue
                    except (OSError, ValueError) as error:
                        decky.logger.warning("Could not install the purchased Master Keyboard collection: %s", error)
            with suppress(TimeoutError):
                await asyncio.wait_for(self.checkout_change.wait(), delay)

    async def get_settings(self):
        return dict(self.live_settings())

    async def get_preview(self, settings):
        if not isinstance(settings, dict):
            raise ValueError("Masterkeyboard preview settings must be an object")
        options = dict(settings)
        show_focus = options.pop("preview_focus", True)
        if type(show_focus) is not bool:
            raise ValueError("preview_focus must be a boolean")
        requested = validate_settings(options)
        if self.colors_locked:
            requested = {key: value for key, value in requested.items() if key not in PREMIUM_COLOR_SETTINGS}
        preview_settings = {**self.live_settings(), **requested}
        if self.public and preview_settings["shape"] not in self.public.unlocked:
            raise ValueError("This theme is available as a Premium preview.")
        return self.theme.preview(preview_settings, show_focus)

    async def set_settings(self, settings):
        patch = validate_settings(settings)
        if self.public and "shape" in patch and patch["shape"] not in self.public.unlocked:
            raise ValueError("Unlock this Premium theme before using it.")
        if self.colors_locked:
            patch = {key: value for key, value in patch.items() if key not in PREMIUM_COLOR_SETTINGS}
        next_settings = {**self.settings, **patch}
        if next_settings != self.settings:
            desired = self.theme.stylesheet(self.live_settings(next_settings))
            newly_enabled = next_settings["enabled"] and not self.settings["enabled"]
            had_lock = self.render_lock is not None
            if newly_enabled and not self.acquire_renderer():
                raise ValueError("Turn off the other Master Keyboard edition first.")
            try:
                write_settings(self.settings_path, next_settings)
            except OSError:
                if newly_enabled and not had_lock:
                    self.release_renderer()
                raise
            self.settings = next_settings
            self.desired = desired
            self.change.set()
        return dict(self.live_settings())

    async def paste_gamescope_codex(self):
        return await self._codex_editor_action()

    async def select_all_gamescope_codex(self):
        return await self._codex_editor_action("select-all")

    async def copy_gamescope_codex(self):
        return await self._codex_editor_action("copy")

    async def editor_shortcut_gamescope_codex(self, action):
        if action not in ("select-all", "copy", "cut", "undo", "redo", "previous-word", "next-word", "delete-word"):
            return False
        return await self._codex_editor_action(action)

    async def _codex_editor_action(self, *args):
        async with self.editor_action_lock:
            if not self.settings["enabled"]:
                return False
            try:
                uid = Path("/tmp/.X11-unix/X0").stat().st_uid
                if not uid or Path("/tmp/.X11-unix/X1").stat().st_uid != uid:
                    return False
                if os.geteuid() not in (0, uid):
                    return False
                user = pwd.getpwuid(uid)
                permissions = {"user": uid, "group": user.pw_gid, "extra_groups": ()} if os.geteuid() == 0 else {}
                process = await asyncio.create_subprocess_exec(
                    "/usr/bin/python3", "-I", str(Path(decky.DECKY_PLUGIN_DIR) / "assets/gamescope-paste.py"), *args,
                    env={
                        "DISPLAY": ":1",
                        "GDK_BACKEND": "x11",
                        "HOME": user.pw_dir,
                        "XDG_RUNTIME_DIR": f"/run/user/{uid}",
                    },
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    **permissions,
                )
                try:
                    return await asyncio.wait_for(process.wait(), 1.65) in (0, 2)
                except TimeoutError:
                    with suppress(ProcessLookupError):
                        process.kill()
                    await process.wait()
                    return True
            except (KeyError, OSError):
                return False

    async def watch(self):
        timeout = aiohttp.ClientTimeout(total=3)
        async with aiohttp.ClientSession(timeout=timeout) as client:
            while True:
                self.change.clear()
                preset = self.settings["typing_sound_style"]
                if preset is None:
                    preset = "Clicky" if self.settings["typing_sound"] else "Steam"
                if self.render_lock is not None:
                    css, revision = self.desired
                    await self.reconcile(client, css, revision, preset)
                    if not revision and not self.settings["enabled"]:
                        self.release_renderer()
                with suppress(TimeoutError):
                    await asyncio.wait_for(self.change.wait(), POLL_INTERVAL)

    async def reconcile(self, client, css, revision, preset=None):
        try:
            async with client.get(STEAM_TARGETS_URL, allow_redirects=False) as response:
                response.raise_for_status()
                targets = await response.json()
            typing_shortcuts = {name: self.settings[name] for name in TYPING_SHORTCUTS}
            updates = [
                style_page(client, url, css, revision, preset not in (None, "Off"),
                           self.reference_script,
                           self.reference_revision + ("+preview" if self.settings["typing_preview"] else ""),
                           typing_shortcuts)
                for target in targets if (url := steam_socket(target))
            ]
            updates.extend(
                shared_page(client, url, preset if revision else None)
                for target in targets if (url := steam_socket(target, shared=True))
            )
            outcomes = await asyncio.gather(*updates, return_exceptions=True)
            failure = next((value for value in outcomes if isinstance(value, Exception)), None)
        except (OSError, ValueError, aiohttp.ClientError, TimeoutError) as error:
            failure = error
        description = str(failure) if failure else None
        if description and description != self.error and revision:
            decky.logger.debug("Waiting to style the Steam keyboard: %s", description)
        self.error = description
