"""Dispatch editor shortcuts to the focused Codex window under Gamescope."""
import sys

import gi
from Xlib import X, XK, display, error
from Xlib.ext import xtest
from Xlib.protocol import event

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk


def property_number(server, window, name):
    prop = window.get_full_property(server.intern_atom(name), X.AnyPropertyType)
    return int(prop.value[0]) if prop is not None and len(prop.value) else None


def focused_codex(steam, app):
    root = steam.screen().root
    overlay_id = property_number(steam, root, "_NET_ACTIVE_WINDOW")
    app_id = property_number(steam, root, "GAMESCOPE_FOCUSED_WINDOW")
    if not overlay_id or not app_id:
        return None
    overlay = steam.create_resource_object("window", overlay_id)
    if property_number(steam, overlay, "STEAM_INPUT_FOCUS") != 2:
        return None
    focus = app.get_input_focus().focus
    if getattr(focus, "id", None) != app_id:
        return None
    wm_class = focus.get_wm_class() or ()
    if not any(name.casefold().split()[0] in ("chatgpt", "codex") for name in wm_class if name.strip()):
        return None
    return app_id


def paste(steam_name=":0", app_name=":1"):
    steam = display.Display(steam_name)
    app = display.Display(app_name)
    target = focused_codex(steam, app)
    if target is None:
        return None
    try:
        return paste_into_codex(steam, app, target, steam_name, app_name)
    except (OSError, error.DisplayError, error.XError):
        return False


def paste_into_codex(steam, app, target, steam_name, app_name):
    clipboard = None
    selection = app.intern_atom("CLIPBOARD")
    if not app.get_selection_owner(selection):
        steam_gdk = Gdk.Display.open(steam_name)
        app_gdk = Gdk.Display.open(app_name)
        if not steam_gdk or not app_gdk:
            return False
        upstream = Gtk.Clipboard.get_for_display(steam_gdk, Gdk.SELECTION_CLIPBOARD)
        text = upstream.wait_for_text()
        if not text or focused_codex(steam, app) != target or app.get_selection_owner(selection):
            return False
        clipboard = Gtk.Clipboard.get_for_display(app_gdk, Gdk.SELECTION_CLIPBOARD)
        clipboard.set_text(text, -1)
        app_gdk.sync()

    if focused_codex(steam, app) != target:
        return False
    # Chromium handles XF86Paste directly. Gamescope can drop synthetic Ctrl
    # modifiers on the secondary XWayland display.
    keycode = app.keysym_to_keycode(0x1008FF6D)  # XF86Paste
    if not keycode or not app.has_extension("XTEST"):
        return False
    xtest.fake_input(app, X.KeyPress, keycode)
    xtest.fake_input(app, X.KeyRelease, keycode)
    app.sync()

    if clipboard is not None:
        # Serve the temporary selection until the receiving application has processed the shortcut.
        loop = GLib.MainLoop()
        GLib.timeout_add(500, loop.quit)
        loop.run()
    return True


def control_shortcut(key, steam_name=":0", app_name=":1", *, shift=False):
    steam = display.Display(steam_name)
    app = display.Display(app_name)
    target = focused_codex(steam, app)
    if target is None:
        return None
    return send_control_shortcut(app, key, lambda: focused_codex(steam, app) == target, shift=shift)


def send_control_shortcut(app, key, still_focused, *, shift=False):
    keycode = app.keysym_to_keycode(XK.string_to_keysym(key))
    focus = app.get_input_focus().focus
    if not keycode or not getattr(focus, "id", None) or not still_focused():
        return False

    root = app.screen().root
    modifiers = X.ControlMask | (X.ShiftMask if shift else 0)
    for event_class, mask in ((event.KeyPress, X.KeyPressMask), (event.KeyRelease, X.KeyReleaseMask)):
        focus.send_event(event_class(
            time=X.CurrentTime, root=root, window=focus, child=X.NONE,
            root_x=0, root_y=0, event_x=0, event_y=0, same_screen=1,
            detail=keycode, state=modifiers,
        ), event_mask=mask, propagate=True)
    app.sync()
    return True


if __name__ == "__main__":
    actions = {
        "select-all": "a", "copy": "c", "cut": "x", "undo": "z", "redo": "z",
        "previous-word": "Left", "next-word": "Right", "delete-word": "BackSpace",
    }
    args = sys.argv[1:]
    try:
        if not args:
            success = paste()
        elif len(args) == 1 and args[0] in actions:
            success = control_shortcut(actions[args[0]], shift=args[0] == "redo")
        else:
            success = None
    except (OSError, error.DisplayError, error.XError):
        success = None
    # Distinguish a non-Codex window from a handled Paste with no available data.
    raise SystemExit(1 if success is None else 0 if success else 2)
