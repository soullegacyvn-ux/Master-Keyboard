((mode, revision, typingPreview, settings = {}) => {
    const hook = Symbol.for("masterkeyboard.referenceLayout");
    if (!mode || !document.documentElement) {
        globalThis[hook]?.restore();
        return;
    }
    if (globalThis[hook]?.mode === mode && globalThis[hook]?.revision === revision) {
        globalThis[hook].setTypingSettings?.(settings);
        return;
    }
    globalThis[hook]?.restore();

    const board = '[role="grid"].DefaultTheme.Layout_qwerty';
    const layerToggle = "MasterkeyboardFn";
    const layerReturn = "MasterkeyboardABC";
    const ctrl = "MasterkeyboardCtrl";
    const alt = "MasterkeyboardAlt";
    const copy = "MasterkeyboardCopy";
    const paste = "MasterkeyboardPaste";
    const selectAll = "MasterkeyboardSelectAll";
    const editorKeys = {
        [copy]: "c", [paste]: "v", [selectAll]: "a", MasterkeyboardCut: "x", MasterkeyboardUndo: "z",
        MasterkeyboardRedo: "redo", MasterkeyboardPreviousWord: "previous-word",
        MasterkeyboardNextWord: "next-word", MasterkeyboardDeleteWord: "delete-word",
    };
    const editorShortcuts = {
        a: ["select-all", "a"], c: ["copy", "c"], x: ["cut", "x"], z: ["undo", "z"],
        redo: ["redo", "z", true], "previous-word": ["previous-word", "ArrowLeft"],
        "next-word": ["next-word", "ArrowRight"], "delete-word": ["delete-word", "Backspace"],
    };
    const ctrlCode = 103;
    const altCode = 100;
    const shiftCode = 101;
    const shiftTapMask = 0b011;
    const shiftOnce = 0b001;
    const shiftLocked = 0b010;
    const shiftTouch = 0b100;
    const shiftDoubleTapMs = 350;
    const spaceDoubleTapMs = 400;
    const punctuation = `-=[]\\;'\`,./`;
    const shifted = `_+{}|:"~<>?`;
    const punctuationCodes = [45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56];
    const specialKeys = {
        Enter: 40, Backspace: 42, Tab: 43, " ": 44,
        ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
    };
    const systemKeys = {
        Escape: ["Esc", 41],
        PrintScreen: ["PrtSc", 70], ScrollLock: ["Scroll Lock", 71], Pause: ["Pause", 72],
        Insert: ["Insert", 73], Home: ["Home", 74], PageUp: ["PgUp", 75],
        Delete: ["Delete", 76], End: ["End", 77], PageDown: ["PgDn", 78],
        NumLock: ["Num Lock", 83], Menu: ["Menu", 106],
        ArrowLeft: ["←", 80], ArrowUp: ["↑", 82], ArrowDown: ["↓", 81], ArrowRight: ["→", 79],
    };
    const functionKeys = Array.from({ length: 12 }, (_, index) => {
        const label = `F${index + 1}`;
        return [label, [label, 58 + index]];
    });
    const extendedKeys = Object.fromEntries(
        [...Object.entries(systemKeys), ...functionKeys].map(([key, spec]) => [`Masterkeyboard${key}`, spec]),
    );
    const stateFor = new WeakMap();
    const heldAttribute = "data-masterkeyboard-held";
    const layoutAttribute = "data-mk-layout";
    let patch;

    // Typing preview: a strip above the keyboard that mirrors what was typed since
    // the keyboard opened, so the text stays readable when the keyboard covers the field.
    const previewId = "masterkeyboard-typing-preview";
    let typed = "";
    let selectedAll = false;
    let previewDismissed = false;
    let managerPatch;
    const typingSettings = {
        shift_double_tap_lock: settings.shift_double_tap_lock !== false,
        double_space_period: settings.double_space_period !== false,
        sentence_capitalization: settings.sentence_capitalization !== false,
    };
    let lastCommitted = "";
    let firstSpaceAt;
    let capitalizeNext = false;

    function resetTyping() {
        lastCommitted = "";
        firstSpaceAt = undefined;
        capitalizeNext = false;
    }

    function setTypingSettings(next = {}) {
        let changed = false;
        for (const key of Object.keys(typingSettings)) {
            const enabled = next[key] !== false;
            changed ||= typingSettings[key] !== enabled;
            typingSettings[key] = enabled;
        }
        if (changed) {
            resetTyping();
            const component = managerPatch?.component;
            if (component) state(component).lastShiftTap = undefined;
        }
    }

    function secretField(manager) {
        const props = manager?.m_ActiveElementProps;
        if (!props || typeof props !== "object") return false;
        try {
            return Object.entries(props).some(([name, value]) =>
                (/passw/i.test(name) && value) || (typeof value === "string" && /passw/i.test(value)));
        } catch {
            return false;
        }
    }

    const toggleId = "masterkeyboard-typing-preview-toggle";

    function removePreview() {
        document.getElementById(previewId)?.remove();
    }

    function resetPreview() {
        typed = "";
        selectedAll = false;
        removePreview();
    }

    // Keep taps on the preview controls away from Steam, which would treat them
    // as a tap outside the keyboard.
    function shield(node, onTap) {
        for (const type of ["pointerdown", "mousedown", "touchstart", "click"]) {
            node.addEventListener(type, event => {
                event.preventDefault();
                event.stopPropagation();
                if (type === "pointerdown") onTap();
            });
        }
    }

    // A small button above the keyboard's right edge that turns the preview on and off.
    function showToggle(root = document.querySelector(board)) {
        const host = root?.parentElement;
        let button = document.getElementById(toggleId);
        if (!typingPreview || !host) {
            button?.remove();
            return;
        }
        if (!button || button.parentElement !== host) {
            button?.remove();
            button = document.createElement("div");
            button.id = toggleId;
            button.setAttribute("role", "button");
            button.style.cssText = "position:absolute;right:10px;z-index:6;box-sizing:border-box;" +
                "padding:6px 12px;border-radius:9px;border:1px solid #ffffff2e;background:#101216f0;" +
                "font:600 13px/1.3 system-ui,sans-serif;white-space:nowrap;pointer-events:auto;";
            shield(button, () => {
                previewDismissed = !previewDismissed;
                showToggle();
                showPreview();
            });
            host.appendChild(button);
        }
        button.textContent = previewDismissed ? "Preview off" : "Preview on";
        button.style.color = previewDismissed ? "#9aa3af" : "#f3f5f8";
        button.setAttribute("aria-pressed", String(!previewDismissed));
        button.style.bottom = `${host.clientHeight - root.offsetTop + 6}px`;
    }

    function showPreview() {
        const root = document.querySelector(board);
        const host = root?.parentElement;
        if (!host || !typed || previewDismissed) {
            removePreview();
            return;
        }
        let strip = document.getElementById(previewId);
        if (!strip || strip.parentElement !== host) {
            strip?.remove();
            strip = document.createElement("div");
            strip.id = previewId;
            strip.setAttribute("aria-hidden", "true");
            strip.style.cssText = "position:absolute;left:50%;transform:translateX(-50%);z-index:5;" +
                "box-sizing:border-box;max-width:min(calc(100% - 280px),960px);display:flex;justify-content:flex-end;" +
                "overflow:hidden;padding:7px 14px;border-radius:10px;border:1px solid #ffffff2e;" +
                "background:#101216f0;color:#f3f5f8;font:600 16px/1.3 system-ui,sans-serif;" +
                "white-space:pre;pointer-events:auto;";
            strip.appendChild(document.createElement("span"));
            shield(strip, () => {});
            host.appendChild(strip);
        }
        strip.firstChild.textContent = typed.slice(-400) + "\u258F";
        strip.style.bottom = `${host.clientHeight - root.offsetTop + 6}px`;
        showToggle(root);
    }

    function trackKey(manager, key, shift) {
        if (typeof key !== "string" || secretField(manager)) {
            if (typed) resetPreview();
            return;
        }
        if (key === "VKClose" || key === "VKDone") {
            resetPreview();
            return;
        }
        if (key === "Backspace") {
            typed = selectedAll ? "" : Array.from(typed).slice(0, -1).join("");
        } else if (key === "Enter") {
            typed = shift ? typed + "\u23CE " : "";
        } else if (key === "VKPaste") {
            typed = (selectedAll ? "" : typed) + "\u2398";
        } else if (key === "Tab") {
            typed += " ";
        } else if (Array.from(key).length === 1) {
            typed = (selectedAll ? "" : typed) + key;
        } else {
            return;
        }
        selectedAll = false;
        showPreview();
    }

    function trackCommand(command) {
        if (!typingPreview) return;
        if (command === "a") {
            selectedAll = true;
            return;
        }
        if (command === "x") typed = selectedAll ? "" : typed;
        else if (command === "delete-word") typed = typed.replace(/\S*\s*$/, "");
        else if (command === "z" || command === "redo") typed = "";
        else return;
        selectedAll = false;
        showPreview();
    }

    function resetOnOutsidePointer(event) {
        if (!event.target?.closest?.(board)) resetTyping();
    }

    function typeText(key, shift, send) {
        if (key === " ") {
            const now = performance.now();
            const replace = typingSettings.double_space_period && firstSpaceAt !== undefined &&
                now - firstSpaceAt <= spaceDoubleTapMs;
            firstSpaceAt = typingSettings.double_space_period && /^[\p{L}\p{N}]$/u.test(lastCommitted) ? now : undefined;
            capitalizeNext ||= replace || lastCommitted === ".";
            lastCommitted = " ";
            if (replace) {
                send("Backspace", false);
                send(".", false);
            }
            return send(key, shift);
        }
        if (typeof key === "string" && Array.from(key).length === 1) {
            if (typingSettings.sentence_capitalization && capitalizeNext && !shift) {
                key = key.toLocaleUpperCase();
            }
            resetTyping();
            lastCommitted = key;
        } else {
            resetTyping();
        }
        return send(key, shift);
    }

    function unwatchManager() {
        if (!managerPatch) return;
        const { manager, original, owned, wrapped, changed, clicked } = managerPatch;
        changed?.Unregister?.();
        clicked?.Unregister?.();
        if (manager.HandleVirtualKeyDown === wrapped) {
            if (owned) manager.HandleVirtualKeyDown = original;
            else delete manager.HandleVirtualKeyDown;
        }
        managerPatch = undefined;
        resetTyping();
    }

    function watchManager(component) {
        const manager = component.props.VirtualKeyboardManager;
        if (managerPatch && managerPatch.manager === manager) {
            managerPatch.component = component;
            return;
        }
        if (typeof manager?.HandleVirtualKeyDown !== "function") return;
        unwatchManager();
        const original = manager.HandleVirtualKeyDown;
        const owned = Object.hasOwn(manager, "HandleVirtualKeyDown");
        const wrapped = function(key, shift) {
            const hasDeadKey = !!this.m_strDeadKeyPending;
            // A pending dead key re-enters with the combined character. Let Steam compose it first.
            const combining = hasDeadKey && this.m_strDeadKeyNext?.includes(key);
            const send = (text, shiftedKey) => {
                if (typingPreview && !combining) {
                    try {
                        trackKey(this, text, shiftedKey);
                    } catch {
                        // The preview must never get in the way of typing.
                    }
                }
                return original.call(this, text, shiftedKey);
            };
            const active = managerPatch?.component;
            if (!active?.m_keyboardDiv?.isConnected || this.IsShowingVirtualKeyboard?.Value === false ||
                !isQwerty(active) || state(active).secondary ||
                hasDeadKey || secretField(this) || (!typingSettings.double_space_period && !typingSettings.sentence_capitalization)) {
                resetTyping();
                return send(key, shift);
            }
            return typeText(key, shift, send);
        };
        manager.HandleVirtualKeyDown = wrapped;
        const changed = manager.OnActiveElementChanged?.Register?.(resetTyping);
        const clicked = manager.OnActiveElementClicked?.Register?.(resetTyping);
        managerPatch = { manager, component, original, owned, wrapped, changed, clicked };
    }

    function keyName(cap) {
        const primary = Array.isArray(cap) ? cap[0] : cap;
        return typeof primary === "string" ? primary : primary?.key;
    }

    function keyCode(key) {
        if (Object.hasOwn(specialKeys, key)) return specialKeys[key];
        if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0) - 61;
        const digit = "1234567890".indexOf(key);
        if (key.length === 1 && digit !== -1) return 30 + digit;
        const shiftedDigit = "!@#$%^&*()".indexOf(key);
        if (key.length === 1 && shiftedDigit !== -1) return 30 + shiftedDigit;
        const index = Math.max(punctuation.indexOf(key), shifted.indexOf(key));
        return key.length === 1 && index !== -1 ? punctuationCodes[index] : undefined;
    }

    function state(component) {
        if (!stateFor.has(component)) stateFor.set(component, { secondary: false, ctrl: false, alt: false });
        return stateFor.get(component);
    }

    function isQwerty(component) {
        return component.state.standardLayout?.name === "qwerty" && component.state.layoutState === 0;
    }

    function layoutFor(component, layout) {
        const rows = layout.rgLayout(component.GetLayoutOptions());
        if (!Array.isArray(rows) || rows.length !== 5 || rows[0]?.length !== 14 ||
            !Array.isArray(layout.rgKeycodes) || rows[4]?.findIndex(cap => keyName(cap) === " ") !== 2) return layout;
        if (!rows[4].some(cap => ["VKClose", "VKDone"].includes(keyName(cap)))) return layout;
        // Steam checks keycap specs with instanceof Object in its own JS realm.
        const KeySpec = rows[4][2].constructor;
        const customKey = (key, label) => [Object.assign(new KeySpec(), { key, label, type: 4 }), 0];
        const existing = (row, index) => [rows[row][index], layout.rgKeycodes[row]?.[index] || 0];
        const layer = state(component);
        const control = customKey(ctrl, "Ctrl");
        const alternate = customKey(alt, "Alt");
        const space = existing(4, 2);
        const selectAllKey = customKey(selectAll, "Select All");
        const steamControls = rows[4].slice(3).map((cap, index) =>
            keyName(cap) === "VKPaste" ? selectAllKey : existing(4, index + 3));
        const layerKey = layer.secondary ? customKey(layerReturn, "ABC") : customKey(layerToggle, "Fn");
        const bottom = [control, alternate, layerKey, space, ...steamControls];
        const rightShift = keyName(rows[3][0]) === "Shift"
            ? rows[3].findLastIndex((cap, index) => index > 0 && keyName(cap) === "Shift")
            : -1;
        const clipboardKeys = [customKey(copy, "Copy"), customKey(paste, "Paste")];
        if (!layer.secondary) {
            // Steam already prepared the typing rows. Only rebuild rows with custom keys.
            const typing = rows.slice(0, 4);
            const codes = typing.map((row, index) =>
                row.map((_, column) => layout.rgKeycodes[index]?.[column] || 0));
            if (rightShift >= 0) {
                typing[3] = typing[3].slice();
                typing[3].splice(rightShift, 1, ...clipboardKeys.map(([key]) => key));
                codes[3].splice(rightShift, 1, 0, 0);
            }
            typing.push(bottom.map(([key]) => key));
            codes.push(bottom.map(([, code]) => code));
            return { ...layout, rgLayout: () => typing, rgKeycodes: codes };
        }

        const keyIn = (row, key) => {
            const index = rows[row].findIndex(cap => keyName(cap) === key);
            return index < 0 ? null : existing(row, index);
        };
        const extra = key => {
            const name = `Masterkeyboard${key}`;
            return customKey(name, extendedKeys[name][0]);
        };
        const result = [
            functionKeys.map(([key]) => extra(key)),
            [extra("Escape"), extra("Insert"), extra("Delete"), extra("PrintScreen"), extra("ScrollLock"),
                extra("Pause"), extra("NumLock"), extra("Menu"), keyIn(0, "Backspace")],
            [extra("Home"), extra("End"), extra("PageUp"), extra("PageDown"),
                extra("ArrowLeft"), extra("ArrowUp"), extra("ArrowDown"), extra("ArrowRight"), keyIn(2, "Enter")],
            [existing(3, 0), customKey("MasterkeyboardCut", "Cut"), ...clipboardKeys,
                customKey("MasterkeyboardUndo", "Undo"), customKey("MasterkeyboardRedo", "Redo"),
                customKey("MasterkeyboardPreviousWord", "Word ←"), customKey("MasterkeyboardNextWord", "Word →"),
                customKey("MasterkeyboardDeleteWord", "Del Word")],
            bottom,
        ];
        const available = result.map(row => row.filter(Boolean));
        return {
            ...layout,
            rgLayout: () => available.map(row => row.map(([cap]) => cap)),
            rgKeycodes: available.map(row => row.map(([, code]) => code)),
        };
    }

    function sharedWindow() {
        try {
            const shared = window.opener;
            return shared?.SteamClient ? shared : window;
        } catch {
            return window;
        }
    }

    function sendChord(input, code, modifiers) {
        if (typeof input?.ControllerKeyboardSetKeyState !== "function") return false;
        const pressed = [];
        try {
            for (const button of [...modifiers, code]) {
                input.ControllerKeyboardSetKeyState(button, true);
                pressed.push(button);
            }
        } finally {
            for (const button of pressed.reverse()) input.ControllerKeyboardSetKeyState(button, false);
        }
        return true;
    }

    function dispatchEditorShortcut(component, command) {
        if (command === "v") {
            component.props.VirtualKeyboardManager.HandleVirtualKeyDown("VKPaste", false);
            return true;
        }
        if (!Object.hasOwn(editorShortcuts, command)) return false;
        trackCommand(command);
        const [action, key, shift] = editorShortcuts[command];
        const shared = sharedWindow();
        const modifiers = shift ? [ctrlCode, shiftCode] : [ctrlCode];
        const send = () => sendChord(shared.SteamClient?.Input, keyCode(key), modifiers);
        if (typeof shared.DeckyBackend?.callable !== "function") return send();
        const call = shared.DeckyBackend.callable("loader/call_plugin_method");
        void call("__MK_BACKEND_NAME__", "editor_shortcut_gamescope_codex", action).then(
            handled => { if (!handled) send(); },
            () => send(),
        );
        return true;
    }

    function attach() {
        const root = document.querySelector(board);
        const fiberKey = root && Object.keys(root).find(key => key.startsWith("__reactFiber$"));
        for (let fiber = root?.[fiberKey]; fiber; fiber = fiber.return) {
            const component = fiber.stateNode;
            const prototype = component && Object.getPrototypeOf(component);
            if (typeof prototype?.RenderStandardKeyboard !== "function" ||
                typeof prototype.TypeKeyInternal !== "function" || !component.state?.standardLayout) continue;
            const render = prototype.RenderStandardKeyboard;
            const type = prototype.TypeKeyInternal;
            const updateTouch = prototype.ToggleStatesUpdate;
            const update = prototype.componentDidUpdate;
            const unmount = prototype.componentWillUnmount;
            const renderLayer = function(layout) {
                const rendered = layout?.name === "qwerty" ? layoutFor(this, layout) : layout;
                const layer = state(this);
                layer.rendered = rendered === layout ? null : layer.secondary ? "fn" : "typing";
                return render.call(this, rendered);
            };
            const typeLayer = function(options) {
                watchManager(this);
                if (!isQwerty(this)) {
                    resetTyping();
                    return type.call(this, options);
                }
                const key = options.strKey;
                const layer = state(this);
                if (key === "VKClose" || key === "VKDone") {
                    resetTyping();
                    stateFor.delete(this);
                    return type.call(this, options);
                }
                if (key === "Shift") {
                    resetTyping();
                    const now = performance.now();
                    const quickTap = typingSettings.shift_double_tap_lock && layer.lastShiftTap !== undefined &&
                        now - layer.lastShiftTap <= shiftDoubleTapMs;
                    layer.lastShiftTap = now;
                    // Keep the touch bit until Steam processes the release.
                    this.setState(({ toggleStates }) => {
                        const current = toggleStates.Shift;
                        const tap = current & shiftTapMask;
                        const next = tap === shiftOnce && quickTap ? shiftLocked : tap ? 0 : shiftOnce;
                        return { toggleStates: { ...toggleStates, Shift: (current & ~shiftTapMask) | next } };
                    });
                    return;
                }
                layer.lastShiftTap = undefined;
                if (key === layerToggle || key === layerReturn) {
                    resetTyping();
                    layer.secondary = key === layerToggle;
                    this.forceUpdate();
                    return;
                }
                if (key === ctrl || key === alt) {
                    resetTyping();
                    if (key === ctrl) layer.ctrl = !layer.ctrl;
                    else layer.alt = !layer.alt;
                    this.forceUpdate();
                    return;
                }
                if (Object.hasOwn(editorKeys, key)) {
                    resetTyping();
                    dispatchEditorShortcut(this, editorKeys[key]);
                    return;
                }
                const extra = Object.hasOwn(extendedKeys, key) ? extendedKeys[key] : null;
                if (options.strDeadKeyNext || key === "CapsLock" || key?.startsWith("SwitchKeys_") || key?.startsWith("IME_")) {
                    resetTyping();
                }
                if (!extra && !layer.ctrl && !layer.alt) return type.call(this, options);
                resetTyping();
                const code = extra ? extra[1] : typeof key === "string" && keyCode(key);
                if (!code) return type.call(this, options);

                const shift = options.strShifted === "1" || (extra && this.state.toggleStates.Shift);
                const modifiers = [layer.ctrl && ctrlCode, layer.alt && altCode, shift && shiftCode].filter(Boolean);
                if (layer.ctrl && !layer.alt) {
                    const lower = key.toLowerCase();
                    const command = shift ? (lower === "z" ? "redo" : null) : lower;
                    if (command && dispatchEditorShortcut(this, command)) return;
                }
                if (!sendChord(sharedWindow().SteamClient?.Input, code, modifiers) && !extra) {
                    return type.call(this, options);
                }
            };

            const updateTouchLayer = function(current, touches, wasMultitouch) {
                const next = updateTouch.call(this, current, touches, wasMultitouch);
                if (isQwerty(this) && (current.Shift & shiftTouch) && !touches?.Shift) {
                    // TypeKey already handled the tap. Touch release only clears the momentary press.
                    next.Shift = current.Shift & ~shiftTouch;
                }
                return next;
            };
            const updateLayer = function(...args) {
                const result = update?.apply(this, args);
                const layer = stateFor.get(this);
                const keyboard = this.m_keyboardDiv;
                if (keyboard && layer?.rendered && keyboard.matches(board)) {
                    if (keyboard.getAttribute(layoutAttribute) !== layer.rendered) {
                        keyboard.setAttribute(layoutAttribute, layer.rendered);
                    }
                } else {
                    keyboard?.removeAttribute(layoutAttribute);
                }
                if (keyboard && layer && (layer.ctrl || layer.alt || layer.marked)) {
                    keyboard.querySelector(`[data-key="${ctrl}"][data-key-row]`)?.toggleAttribute(heldAttribute, layer.ctrl);
                    keyboard.querySelector(`[data-key="${alt}"][data-key-row]`)?.toggleAttribute(heldAttribute, layer.alt);
                    layer.marked = layer.ctrl || layer.alt;
                }
                return result;
            };
            const unmountLayer = function(...args) {
                this.m_keyboardDiv?.removeAttribute(layoutAttribute);
                stateFor.delete(this);
                if (managerPatch?.component === this) unwatchManager();
                resetPreview();
                document.getElementById(toggleId)?.remove();
                return unmount?.apply(this, args);
            };
            prototype.RenderStandardKeyboard = renderLayer;
            prototype.TypeKeyInternal = typeLayer;
            if (typeof updateTouch === "function") prototype.ToggleStatesUpdate = updateTouchLayer;
            prototype.componentDidUpdate = updateLayer;
            prototype.componentWillUnmount = unmountLayer;
            patch = { prototype, render, type, updateTouch, update, unmount,
                renderLayer, typeLayer, updateTouchLayer, updateLayer, unmountLayer };
            watchManager(component);
            showToggle();
            observer.disconnect();
            component.forceUpdate();
            return;
        }
    }

    // The theme highlights a default key while no key has gamepad focus. Mirror
    // "some key has focus" in an attribute so the stylesheet does not need a
    // keyboard-wide :has(), which Steam re-evaluates for every key on each press.
    const focusAttribute = "data-mk-key-focus";
    const focusObserver = new MutationObserver(records => {
        for (const record of records) {
            if (!record.target.hasAttribute?.("data-key-row")) continue;
            const keyboard = record.target.closest('[role="grid"].DefaultTheme');
            keyboard?.toggleAttribute(focusAttribute, !!keyboard.querySelector("[data-key-row].gpfocus"));
            // The keyboard is on screen: make sure the preview button is too.
            if (typingPreview && !document.getElementById(toggleId)) showToggle();
            return;
        }
    });
    const observer = new MutationObserver(attach);
    globalThis[hook] = {
        mode,
        revision,
        typingSettings,
        setTypingSettings,
        restore() {
            observer.disconnect();
            focusObserver.disconnect();
            document.querySelectorAll(`[${focusAttribute}]`).forEach(node => node.removeAttribute(focusAttribute));
            document.querySelectorAll(`[${layoutAttribute}]`).forEach(node => node.removeAttribute(layoutAttribute));
            removePreview();
            document.getElementById(toggleId)?.remove();
            document.removeEventListener("pointerdown", resetOnOutsidePointer, true);
            unwatchManager();
            if (patch) {
                const { prototype, render, type, updateTouch, update, unmount,
                    renderLayer, typeLayer, updateTouchLayer, updateLayer, unmountLayer } = patch;
                if (prototype.RenderStandardKeyboard === renderLayer) prototype.RenderStandardKeyboard = render;
                if (prototype.TypeKeyInternal === typeLayer) prototype.TypeKeyInternal = type;
                if (prototype.ToggleStatesUpdate === updateTouchLayer) prototype.ToggleStatesUpdate = updateTouch;
                if (prototype.componentDidUpdate === updateLayer) {
                    if (update) prototype.componentDidUpdate = update;
                    else delete prototype.componentDidUpdate;
                }
                if (prototype.componentWillUnmount === unmountLayer) {
                    if (unmount) prototype.componentWillUnmount = unmount;
                    else delete prototype.componentWillUnmount;
                }
                const root = document.querySelector(board);
                root?.querySelectorAll(`[${heldAttribute}]`).forEach(hit => hit.removeAttribute(heldAttribute));
                const fiberKey = root && Object.keys(root).find(key => key.startsWith("__reactFiber$"));
                for (let fiber = root?.[fiberKey]; fiber; fiber = fiber.return) {
                    if (fiber.stateNode && Object.getPrototypeOf(fiber.stateNode) === prototype) {
                        fiber.stateNode.forceUpdate();
                        break;
                    }
                }
            }
            delete globalThis[hook];
        },
    };
    observer.observe(document.documentElement, { childList: true, subtree: true });
    focusObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"], subtree: true });
    document.addEventListener("pointerdown", resetOnOutsidePointer, true);
    attach();
})
