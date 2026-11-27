import { callable, definePlugin } from "@decky/api";
import {
  ButtonItem,
  DialogButton,
  Focusable,
  PanelSection,
  PanelSectionRow,
  SliderField,
  TextField,
  ToggleField,
  staticClasses,
  Navigation,
} from "@decky/ui";
import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import profiles from "../assets/theme/profiles.json";
import peachSlate from "../assets/theme/peach-slate.json";
import { version as installedVersion } from "../package.json";
import plugin from "../plugin.json";
import { checkoutQrData } from "./checkout-qr";
import { installStagedUpdate } from "./install-update";

type KeyShape = keyof typeof profiles;
type ExtraShape = Exclude<KeyShape, "Sculpted" | "Square">;
type TypingSound = "Clicky" | "Thock" | "Soft" | "Steam" | "Off";
const typingSounds: TypingSound[] = ["Clicky", "Thock", "Soft", "Steam", "Off"];

const keyboardHeights = [-20, -16, -12, -8, -4, 0, 4, 8] as const;
type KeyboardHeight = (typeof keyboardHeights)[number];

type ColorBlock = keyof (typeof profiles)["Sculpted"]["colors"];
type BlockColors = Partial<Record<ColorBlock, string>>;
type BlockBrightness = Partial<Record<ColorBlock, number>>;
type KeyPalette = { colors: BlockColors; brightness: BlockBrightness };
const factoryPalette: KeyPalette = { colors: {}, brightness: {} };
const blockKeys = Object.keys(profiles.Sculpted.colors) as ColorBlock[];
function defaultColors(shape: KeyShape): Record<ColorBlock, string> {
  const { colors } = profiles[shape];
  return Object.fromEntries(blockKeys.map((block) => [block, colors[block].color])) as Record<ColorBlock, string>;
}

const colorSchemes = [
  peachSlate,
  { data: "terminal", label: "Terminal SA", colors: defaultColors("Terminal") },
  { data: "console", label: "Retro Console", colors: defaultColors("Console") },
  {
    data: "ocarina", label: "Ocarina",
    colors: { cream: "#d9c89b", blue: "#47734c", gold: "#dbad52", amber: "#456795", red: "#8e4a3b" },
  },
  {
    data: "midnight-teal", label: "Midnight Teal",
    colors: { cream: "#293847", blue: "#296967", gold: "#74acab", amber: "#42647c", red: "#ba815e" },
  },
  {
    data: "porcelain-blue", label: "Porcelain Blue",
    colors: { cream: "#eae8df", blue: "#31557f", gold: "#bec9d5", amber: "#7199b0", red: "#ad5d54" },
  },
  {
    data: "sakura-smoke", label: "Sakura Smoke",
    colors: { cream: "#dcd3d8", blue: "#68495f", gold: "#d39da6", amber: "#7f8b9d", red: "#a8676a" },
  },
  {
    data: "graphite-amber", label: "Graphite Amber",
    colors: { cream: "#303135", blue: "#464753", gold: "#cf9a46", amber: "#8c7154", red: "#9e5451" },
  },
  {
    data: "ink-jade", label: "Ink & Jade",
    colors: { cream: "#1d262b", blue: "#245c4d", gold: "#9bd6ad", amber: "#d8c49a", red: "#a04952" },
  },
  {
    data: "cream-espresso", label: "Cream & Espresso",
    colors: { cream: "#f0e1cb", blue: "#47312e", gold: "#d7ae77", amber: "#935435", red: "#792d40" },
  },
  {
    data: "persimmon", label: "Persimmon",
    colors: { cream: "#efe4d5", blue: "#2f414b", gold: "#f0be5d", amber: "#e1783f", red: "#a73936" },
  },
  {
    data: "moss-and-clay", label: "Moss & Clay",
    colors: { cream: "#c9c6a9", blue: "#344d3b", gold: "#bfc37e", amber: "#705a42", red: "#a15443" },
  },
  {
    data: "blue-hour", label: "Blue Hour",
    colors: { cream: "#202638", blue: "#35458d", gold: "#a3a9ed", amber: "#70549f", red: "#d38fb1" },
  },
  {
    data: "sea-glass", label: "Sea Glass",
    colors: { cream: "#e0f0ec", blue: "#226b73", gold: "#a9e0d2", amber: "#467b9e", red: "#d9877c" },
  },
  {
    data: "black-cherry", label: "Black Cherry",
    colors: { cream: "#2c222b", blue: "#473d67", gold: "#e0b9a4", amber: "#bc7896", red: "#91344f" },
  },
  {
    data: "signal-lime", label: "Signal Lime",
    colors: { cream: "#25292a", blue: "#435675", gold: "#d0ec63", amber: "#86ac77", red: "#f57b52" },
  },
];

const retroIvory = {
  data: "retro-ivory", label: "Retro Ivory",
  colors: { cream: "#fff1da", blue: "#4388a4", gold: "#d0b44a", amber: "#d99a4b", red: "#c75650" },
};

const rgbChannels = ["Red", "Green", "Blue"];
const colorPresets = [
  ["Ivory", "#eae6d7"], ["Slate", "#424c60"], ["Ocean", "#5892b7"], ["Mint", "#71be9e"],
  ["Gold", "#c9b45d"], ["Amber", "#bf9148"], ["Red", "#c75858"], ["Lilac", "#aa81cb"],
].map(([label, color]) => ({ data: color, label, color }));
const focusPresets = [
  ["Purple", "#c46fba"], ["Blue", "#72b4f3"], ["Mint", "#75ddbd"],
  ["Amber", "#f1bb65"], ["Red", "#ef8780"],
].map(([label, color]) => ({ data: label, label, color }));
type ColorPreset = { data: string; label: string; color?: string; brightness?: number };
const backgroundPresets: ColorPreset[] = [
  { data: "default", label: "Theme default" },
  ...[
    ["Black", "#000000"], ["Graphite", "#242831"], ["Midnight", "#111724"],
    ["Forest", "#213d3a"], ["Burgundy", "#462b37"], ["Ivory", "#d9d3c8"],
  ].map(([label, color]) => ({ data: color, label, color })),
];

// Decky can remount the panel while Steam refreshes Quick Access.
let colorEditorState: { block: ColorBlock; advanced: boolean } = {
  block: "cream",
  advanced: false,
};
let focusRgbExpanded = false;
let backgroundRgbExpanded = false;

interface Settings {
  enabled: boolean;
  shape: KeyShape;
  height: KeyboardHeight;
  transparent: boolean;
  background_color?: string | null;
  background_transparency?: number | null;
  typing_sound: boolean;
  typing_sound_style?: TypingSound | null;
  typing_preview?: boolean;
  split_keyboard?: boolean;
  shift_double_tap_lock?: boolean;
  double_space_period?: boolean;
  sentence_capitalization?: boolean;
  focus_color: string;
  focus_brightness: number;
  preview_open: boolean;
  block_colors: BlockColors;
  square_block_colors?: BlockColors;
  style_block_colors?: Partial<Record<ExtraShape, BlockColors>>;
  wukong_block_brightness?: BlockBrightness;
  wukong_default_palette?: KeyPalette | null;
}

type StoredSettings = Omit<Settings, "shape"> & { shape: string };
const readSettings = callable<[], StoredSettings>("get_settings");
const writeSettings = callable<[Partial<Settings>], StoredSettings>("set_settings");
type PreviewOptions = Partial<Settings> & { preview_focus?: boolean };
const getPreview = callable<[PreviewOptions], string>("get_preview");
type Access = {
  public: boolean;
  store: string | null;
  price?: string | null;
  active: boolean;
  pending: boolean;
  renewing?: boolean;
  checkout_url?: string | null;
  locked: KeyShape[];
  colors_locked?: boolean;
  plasma_install?: boolean;
};
const getAccess = callable<[], Access>("get_access");
const getPremiumPreview = callable<[KeyShape], string>("get_premium_preview");
const activatePurchase = callable<[string], { error: string } | { access: Access; settings: StoredSettings }>("activate_purchase");
const beginCheckout = callable<[], { error: string } | { access: Access; url: string }>("begin_checkout");
const checkUpdate = callable<[boolean], { version: string } | null>("check_update");
const prepareUpdate = callable<[string], { artifact: string; hash: string }>("prepare_update");
type PlasmaSetupResult = { installed: true; version: string; already_current?: boolean; updated?: boolean }
  | { error: string };
const installPlasma = callable<[], PlasmaSetupResult>("install_plasma");
const shapes = Object.keys(profiles) as KeyShape[];
let nextShapeNumber = 1;
const shapeOptions = shapes.map((shape) => {
  const profile = profiles[shape];
  const number = "number" in profile ? profile.number : nextShapeNumber;
  nextShapeNumber = number + 1;
  return { data: shape, label: `${String(number).padStart(2, "0")} ${profile.label}` };
});

const retiredShapes: Record<string, KeyShape | undefined> = {
  Bauhaus: "PastelPlush",
  LilacSilicone: "PastelPlush",
  Rally: "Translucent",
  Obsidian: "SpectrumRGB",
};

function normalizeSettings(settings: StoredSettings): Settings {
  const requested = retiredShapes[settings.shape] ?? settings.shape;
  const shape = shapes.find((option) => option === requested) ?? "Sculpted";
  return { ...settings, shape };
}

let pendingWrite = Promise.resolve();
let latestWrite = 0;
let queuedChanges: Partial<Settings> = {};
let lastPreview: { options: string; html: string } | undefined;

function saveSettings(patch: Partial<Settings>): Promise<Settings | undefined> {
  const revision = ++latestWrite;
  queuedChanges = { ...queuedChanges, ...patch };
  // Coalesce slider updates without sending unrelated settings from a stale panel.
  const result = pendingWrite.then(() => {
    if (revision !== latestWrite) return;
    const changes = queuedChanges;
    queuedChanges = {};
    return writeSettings(changes).then(normalizeSettings);
  });
  pendingWrite = result.then(() => undefined, () => undefined);
  return result;
}

function KeyboardIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    >
      <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
      <path d="M6 9.5h1m3 0h1m3 0h1m3 0h.5M6 12.5h1m3 0h1m3 0h1m3 0h.5M8 15.5h8" />
    </svg>
  );
}

function PremiumBadge() {
  return (
    <span className="mk-premium-badge" aria-label="Premium">
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.25" y="7" width="9.5" height="6.75" rx="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2M8 9.75v1.25" />
      </svg>
    </span>
  );
}

function ProBadge() {
  return (
    <span className="mk-pro-badge" aria-label="Premium active">
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round">
        <path d="m4 2.75-2.5 3.5L8 13.5l6.5-7.25L12 2.75H4Z" />
        <path d="M1.5 6.25h13M5.75 6.25 8 13.5l2.25-7.25" />
      </svg>
      <span aria-hidden="true">PRO</span>
    </span>
  );
}

function KeyboardPreviewFrame({ title, html }: { title: string; html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState<number>();
  const height = Number(/--mk-preview-height:\s*(\d+)px/.exec(html)?.[1]) || 386;
  const width = 1024;

  useLayoutEffect(() => {
    const page = frame.current;
    if (!page) return;
    const fit = () => {
      const next = Math.min(page.clientWidth / width, page.clientHeight / height);
      if (next > 0) setScale(next);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(page);
    fit();
    return () => observer.disconnect();
  }, [height]);

  const document = useMemo(() => scale === undefined ? undefined : html.replace("</head>",
    `<style>body { --mk-preview-scale: ${scale.toFixed(6)}; }</style></head>`), [html, scale]);
  return (
    <iframe
      ref={frame}
      title={`${title} preview`}
      srcDoc={document}
      sandbox=""
      scrolling="no"
      tabIndex={-1}
      style={{
        display: "block", width: "100%", height: "auto", aspectRatio: `${width} / ${height}`,
        border: 0, borderRadius: 6, pointerEvents: "none",
      }}
    />
  );
}

function PremiumPreview({ shape }: { shape: KeyShape }) {
  const title = shapeOptions.find((option) => option.data === shape)?.label ?? "Keyboard";
  const [image, setImage] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getPremiumPreview(shape).then(
      (src) => { if (!cancelled) setImage(src); },
      () => { if (!cancelled) setError(true); },
    );
    return () => { cancelled = true; };
  }, [shape]);

  return (
    <div className="mk-preview-card">
      <div className="mk-preview-title"><span>{title}</span><PremiumBadge /></div>
      {image
        ? <img src={image} alt={`${title} keyboard layout`} draggable={false} />
        : <div role={error ? "alert" : "status"}>{error ? "Could not load preview." : "Loading preview…"}</div>}
      <div className="mk-premium-hint">Preview only · typing locked</div>
    </div>
  );
}

const supportEmail = "soullegacyvn@gmail.com";

function PlasmaSetup() {
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();

  async function install() {
    setInstalling(true);
    setStatus(undefined);
    try {
      const result = await installPlasma();
      if ("error" in result) {
        setStatus({ ok: false, text: result.error });
      } else if (result.already_current) {
        setStatus({ ok: true, text: `Plasma keyboard ${result.version} is already up to date.` });
      } else {
        const completion = result.updated
          ? `Updated Plasma keyboard to ${result.version}.`
          : `Installed Plasma keyboard ${result.version}.`;
        setStatus({ ok: true, text: `${completion} Open Desktop Mode to use it.` });
      }
    } catch {
      setStatus({ ok: false, text: "Plasma setup did not finish. Try again." });
    } finally {
      setInstalling(false);
    }
  }

  return (
    <>
      <PanelSectionRow>
        <SettingsButton label={installing ? "Preparing Plasma keyboard…" : "Install or update Plasma keyboard"}
          disabled={installing} onClick={() => void install()} />
      </PanelSectionRow>
      {status && <PanelSectionRow>
        <div className="mk-premium-hint" role={status.ok ? "status" : "alert"}>{status.text}</div>
      </PanelSectionRow>}
    </>
  );
}

function openExternal(url: string) {
  const steam = (window as Window & {
    SteamClient?: { System?: { OpenInSystemBrowser?: (url: string) => void } };
  }).SteamClient;
  // Gaming Mode has no system browser to hand a link to. Web pages open in
  // Steam's own browser there; other links (mailto:) still go to the system.
  if (/^https?:/i.test(url)) {
    try {
      Navigation.CloseSideMenus();
      Navigation.NavigateToExternalWeb(url);
      return;
    } catch {
      // Fall through to the system browser.
    }
  }
  if (steam?.System?.OpenInSystemBrowser) steam.System.OpenInSystemBrowser(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

const sendSupport = callable<[string, string], { sent: true } | { error: string }>("send_support");

function ContactSupport() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  async function send() {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const result = await sendSupport(email.trim(), text.trim());
      if ("error" in result) setError(result.error);
      else {
        setText("");
        setStatus("Message sent. We reply by email.");
      }
    } catch {
      setError("The message could not be sent. Try again later.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsButton label="Contact support" quieter expanded={open} arrow={open ? "▴" : "▾"}
        onClick={() => setOpen(!open)} />
      {open && (
        <>
          <TextField label="Your email" value={email}
            onChange={(event) => setEmail(event.target.value.slice(0, 120))} />
          <TextField label="Message" value={text}
            onChange={(event) => setText(event.target.value.slice(0, 2000))} />
          <SettingsButton label={busy ? "Sending…" : "Send message"}
            disabled={busy || !email.trim() || text.trim().length < 5} onClick={() => void send()} />
          <div className="mk-premium-hint">Or write to {supportEmail}.</div>
        </>
      )}
      {status && <div className="mk-premium-hint" role="status">{status}</div>}
      {error && <div role="alert">{error}</div>}
    </>
  );
}

function PurchasePanel({ access, onCheckout, onActivated }: {
  access: Access;
  onCheckout: (access: Access) => void;
  onActivated: (access: Access, settings: StoredSettings) => void;
}) {
  const [showCheckout, setShowCheckout] = useState(true);
  const [showRestore, setShowRestore] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const checkoutUrl = access.checkout_url;
  const checkoutQR = useMemo(() => checkoutUrl ? checkoutQrData(checkoutUrl) : undefined, [checkoutUrl]);

  const openBrowser = openExternal;

  async function checkout() {
    if (checkoutUrl) {
      setShowCheckout(!showCheckout);
      return;
    }
    if (!access.store) {
      setMessage("PayPal checkout and purchase recovery are coming soon.");
      return;
    }
    setOpening(true);
    setError(undefined);
    try {
      const result = await beginCheckout();
      if ("error" in result) setError(result.error);
      else {
        onCheckout(result.access);
        setShowCheckout(true);
      }
    } catch {
      setError("Could not open the PayPal checkout. Try again.");
    } finally {
      setOpening(false);
    }
  }

  async function activate() {
    setBusy(true);
    setError(undefined);
    try {
      await pendingWrite;
      const result = await activatePurchase(key.trim().toUpperCase());
      if ("error" in result) setError(result.error);
      else {
        onActivated(result.access, result.settings);
        setKey("");
        setShowRestore(false);
      }
    } catch {
      setError("Could not restore the purchase. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mk-purchase-panel">
      <SettingsButton label="Unlock Premium"
        disabled={opening} value={access.price ?? <PremiumBadge />}
        expanded={checkoutUrl ? showCheckout : undefined}
        arrow={checkoutUrl && showCheckout ? "▴" : "▾"} onClick={() => void checkout()} />
      {checkoutUrl && showCheckout && (
        <div className="mk-checkout-card">
          <div className="mk-checkout-label">Scan with your phone to pay</div>
          <img src={checkoutQR} alt="QR code for your PayPal checkout" draggable={false} />
          <SettingsButton label="Open checkout in browser" arrow="›" onClick={() => openBrowser(checkoutUrl)} />
        </div>
      )}
      {access.pending && <div className="mk-premium-hint" role="status">Waiting for PayPal. Premium unlocks here after payment.</div>}
      <SettingsButton label="Restore purchase" quieter expanded={showRestore} arrow={showRestore ? "▴" : "▾"}
        onClick={() => {
          setMessage(undefined);
          setShowRestore(!showRestore);
        }} />
      {showRestore && (access.store ? (
        <>
          <TextField label="License key" value={key} onChange={(event) => setKey(event.target.value.slice(0, 60))} />
          <SettingsButton label={busy ? "Restoring…" : "Activate license"} disabled={busy || !key.trim()}
            onClick={() => void activate()} />
          <SettingsButton label="Recover by receipt email" arrow="›" onClick={() => openBrowser(access.store + "/recover")} />
        </>
      ) : <div className="mk-premium-hint">License key and receipt recovery will be available when PayPal is connected.</div>)}
      {message && <div className="mk-premium-hint" role="status">{message}</div>}
      {error && <div role="alert">{error}</div>}
    </div>
  );
}

function Preview({ settings, showFocus }: { settings: Settings; showFocus: boolean }) {
  const {
    shape, height, transparent, background_color, background_transparency,
    focus_color, focus_brightness, block_colors, square_block_colors, style_block_colors, wukong_block_brightness,
  } = settings;
  const options = JSON.stringify({
    shape, height, transparent, background_color, background_transparency,
    focus_color, focus_brightness,
    ...(shape === "Square" ? { square_block_colors }
      : shape === "Sculpted" ? { block_colors } : { style_block_colors }),
    ...(shape === "Wukong" ? { wukong_block_brightness } : {}),
    preview_focus: showFocus,
  });
  const [html, setHtml] = useState(lastPreview?.options === options ? lastPreview.html : undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (lastPreview?.options === options) {
      setHtml(lastPreview.html);
      setError(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void getPreview(JSON.parse(options)).then(
        (preview) => {
          if (cancelled) return;
          lastPreview = { options, html: preview };
          setHtml(preview);
          setError(false);
        },
        () => {
          if (!cancelled) setError(true);
        },
      );
    }, 160);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [options]);

  if (!html) {
    return error
      ? <div role="alert">Could not load preview.</div>
      : <div role="status">Loading preview…</div>;
  }

  const title = shapeOptions.find((option) => option.data === shape)?.label ?? "Masterkeyboard";
  return (
    <div className="mk-preview-card mk-live-preview">
      <KeyboardPreviewFrame title={title} html={html} />
      {error && <div role="alert">Could not update preview.</div>}
    </div>
  );
}

const panelCss = `
  #masterkeyboard-controls.mk-panel {
    display: grid; gap: 14px; min-width: 0; padding-bottom: 8px;
  }
  #masterkeyboard-controls .mk-panel-group { display: grid; gap: 7px; min-width: 0; }
  #masterkeyboard-controls .mk-panel-group > * { min-width: 0; margin-block: 0; }
  #masterkeyboard-controls .mk-section-title {
    display: flex; align-items: center; gap: 9px;
    color: #aab8c9; margin: 0 0 2px; font-size: 11px; font-weight: 650;
    letter-spacing: .065em; text-transform: uppercase;
  }
  #masterkeyboard-controls .mk-section-title::after { content: ""; flex: 1; height: 1px; background: #ffffff18; }
  #masterkeyboard-controls .mk-enabled-label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  #masterkeyboard-controls .mk-pro-badge {
    display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px;
    color: #f4d38e; background: #362b1e; border: 1px solid #9e804d;
    border-radius: 6px; font-size: 10px; font-weight: 750; letter-spacing: .08em; line-height: 1;
  }
  #masterkeyboard-controls button.mk-row {
    background: #20252e;
    border: 1px solid #ffffff18;
    border-radius: 8px !important;
    box-shadow: none;
    color: #e8edf4;
  }
  #masterkeyboard-controls button.mk-row:hover {
    background: #2c3441;
  }
  #masterkeyboard-controls button.mk-row[aria-pressed="true"] {
    border-color: #7896b6;
    background: #28364a;
  }
  #masterkeyboard-controls button.mk-row:is(.gpfocus, :focus-visible) {
    background: #34475f;
    border-color: #9cc5ef;
    outline: 1px solid #9cc5ef;
    outline-offset: -2px;
    color: #fff;
  }
  #masterkeyboard-controls button.mk-row.mk-reset {
    color: #c4d0dd;
    background: #1c2027;
  }
  #masterkeyboard-controls button.mk-row.mk-reset:is(.gpfocus, :focus-visible) {
    background: #34475f;
    color: #fff;
  }
  #masterkeyboard-controls button.mk-row:is(:disabled, [aria-disabled="true"]) {
    opacity: 0.55;
  }
  #masterkeyboard-controls .mk-locked-name { color: #aab2bf; }
  #masterkeyboard-controls .mk-premium-badge {
    display: inline-grid; place-items: center; width: 19px; height: 17px; flex: 0 0 19px;
    color: #f3c672; background: #3b3024; border: 1px solid #b28b4759; border-radius: 4px;
  }
  #masterkeyboard-controls .mk-preview-card {
    display: grid; gap: 7px; width: 100%; padding: 8px;
    border: 1px solid #ffffff18; border-radius: 8px; background: #1c2027; box-sizing: border-box;
  }
  #masterkeyboard-controls .mk-live-preview { padding: 2px; background: transparent; }
  #masterkeyboard-controls .mk-preview-title {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    font-size: 12px; font-weight: 600;
  }
  #masterkeyboard-controls .mk-preview-card img {
    display: block; width: 100%; height: auto; border-radius: 6px; pointer-events: none;
  }
  #masterkeyboard-controls .mk-premium-hint { color: #bfc8d5; font-size: 12px; line-height: 1.35; }
  #masterkeyboard-controls .mk-purchase-panel { display: grid; gap: 8px; width: 100%; }
  #masterkeyboard-controls .mk-purchase-panel > button:first-child:not(:is(.gpfocus, :focus-visible)) {
    background: #32291e; border-color: #9e804d80; color: #ffdf9c;
  }
  #masterkeyboard-controls .mk-setting-value-text {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  #masterkeyboard-controls .mk-setting-arrow { flex-shrink: 0; opacity: .8; }
  #masterkeyboard-controls .mk-checkout-card {
    display: grid; justify-items: center; gap: 9px; min-width: 0; padding: 10px;
    border: 1px solid #ffffff18; border-radius: 7px; background: #1c2027;
  }
  #masterkeyboard-controls .mk-checkout-label { color: #f1f4f8; font-size: 13px; font-weight: 600; text-align: center; }
  #masterkeyboard-controls .mk-checkout-card img {
    display: block; max-width: 100%; height: auto; background: #fff; image-rendering: pixelated;
  }
`;
const settingButtonStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  gap: 10, width: "100%", minWidth: 0, minHeight: 40, padding: "7px 11px",
  textAlign: "left", fontSize: 13, lineHeight: 1.25,
};
const settingValueStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, flexShrink: 0, minWidth: 0, maxWidth: "58%", color: "inherit", fontSize: 12,
};

function SettingsButton({ label, value, arrow, expanded, disabled, quieter, onClick }: {
  label: string;
  value?: React.ReactNode;
  arrow?: string;
  expanded?: boolean;
  disabled?: boolean;
  quieter?: boolean;
  onClick: () => void;
}) {
  return (
    <DialogButton className={quieter ? "mk-row mk-reset" : "mk-row"} aria-expanded={expanded}
      disabled={disabled} onClick={onClick} style={settingButtonStyle}>
      <span style={{ minWidth: 0 }}>{label}</span>
      {(value || arrow) && (
        <span style={settingValueStyle}>
          {typeof value === "string" ? <span className="mk-setting-value-text">{value}</span> : value}
          {arrow && <span className="mk-setting-arrow" aria-hidden="true">{arrow}</span>}
        </span>
      )}
    </DialogButton>
  );
}

let updateInProgress = false;

function Updates({ bundleVersion }: { bundleVersion: string }) {
  const [available, setAvailable] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState<"download" | "install">();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    void checkUpdate(false).then(
      (update) => { if (mounted) setAvailable((current) => current ?? update?.version); },
      () => undefined,
    );
    return () => { mounted = false; };
  }, []);

  async function refresh() {
    setChecking(true);
    setMessage("");
    setError("");
    try {
      const update = await checkUpdate(true);
      setAvailable(update?.version);
      if (!update) setMessage("You're up to date.");
    } catch {
      setError("Could not check for updates. Try again.");
    } finally {
      setChecking(false);
    }
  }

  async function install(version: string) {
    if (updateInProgress) {
      setMessage("An update is already in progress.");
      return;
    }
    updateInProgress = true;
    setInstalling("download");
    setMessage("");
    setError("");
    try {
      const { artifact, hash } = await prepareUpdate(version);
      await pendingWrite;
      setInstalling("install");
      const result = await installStagedUpdate(plugin.name, version, artifact, hash);
      if (result === "installed") setAvailable(undefined);
    } catch {
      setError("Could not finish the update. Check for updates and try again.");
    } finally {
      updateInProgress = false;
      setInstalling(undefined);
    }
  }

  return (
    <>
      <PanelSectionRow>
        <SettingsButton label={checking ? "Checking…" : "Check for updates"} value={`v${bundleVersion}`}
          disabled={checking || Boolean(installing)} onClick={() => void refresh()} />
      </PanelSectionRow>
      {available && (
        <PanelSectionRow>
          <SettingsButton label={installing === "download" ? "Downloading…" : installing === "install" ? "Installing…" : "Install update"}
            value={`v${available}`} disabled={checking || Boolean(installing)} onClick={() => void install(available)} />
        </PanelSectionRow>
      )}
      {(message || error) && (
        <PanelSectionRow><div className="mk-premium-hint" role={error ? "alert" : "status"}>{error || message}</div></PanelSectionRow>
      )}
    </>
  );
}

const PickerContext = createContext<{
  openPicker?: string;
  setOpenPicker: (label?: string) => void;
}>({ setOpenPicker: () => undefined });

function SettingPicker<T extends string>({ label, selectedOption, rgOptions, onChange }: {
  label: string;
  selectedOption: T;
  rgOptions: { data: T; label: React.ReactNode; locked?: boolean }[];
  onChange: (option: { data: T; label: React.ReactNode }) => void;
}) {
  const { openPicker, setOpenPicker } = useContext(PickerContext);
  const trigger = useRef<HTMLDivElement>(null);
  const expanded = openPicker === label;
  const selected = rgOptions.find((option) => option.data === selectedOption);

  function close(event?: CustomEvent) {
    if (!expanded) return;
    event?.preventDefault();
    event?.stopPropagation();
    setOpenPicker(undefined);
    trigger.current?.querySelector("button")?.focus();
  }

  return (
    <Focusable onCancelButton={expanded ? close : undefined}
      onCancelActionDescription={expanded ? "Close choices" : undefined}>
      <div ref={trigger}>
        <SettingsButton label={label} value={selected?.label} expanded={expanded}
          arrow={expanded ? "▴" : "▾"} onClick={() => {
            if (expanded) close();
            else setOpenPicker(label);
          }}
        />
      </div>
      {expanded && (
        <Focusable flow-children="grid" aria-label={`${label} choices`}
          style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6, paddingTop: 7 }}>
          {rgOptions.map((option) => {
            const isSelected = option.data === selectedOption;
            return (
              <DialogButton className="mk-row" key={option.data} aria-pressed={isSelected} onClick={() => {
                close();
                onChange(option);
              }} style={{ ...settingButtonStyle, minHeight: 38, paddingInline: 8, fontSize: 12 }}>
                <span className={option.locked ? "mk-locked-name" : undefined} style={{ minWidth: 0 }}>{option.label}</span>
                {option.locked ? <PremiumBadge /> : isSelected && <span aria-hidden="true">✓</span>}
              </DialogButton>
            );
          })}
        </Focusable>
      )}
    </Focusable>
  );
}

function PaletteSwatches({ colors }: { colors: BlockColors }) {
  return (
    <span aria-hidden="true" style={{ display: "flex", gap: 3 }}>
      {blockKeys.map((block) => (
        <span key={block} style={{
          width: 9, height: 9, borderRadius: 2, border: "1px solid #ffffff30",
          backgroundColor: colors[block],
        }} />
      ))}
    </span>
  );
}

function paletteColors(shape: KeyShape, palette: KeyPalette) {
  const colors = defaultColors(shape);
  for (const block of blockKeys) {
    colors[block] = shadeColor(palette.colors[block] ?? colors[block], palette.brightness[block] ?? 100);
  }
  return colors;
}

function samePalette(shape: KeyShape, first: KeyPalette, second: KeyPalette) {
  const factory = defaultColors(shape);
  return blockKeys.every((block) =>
    (first.colors[block] ?? factory[block]).toLowerCase() === (second.colors[block] ?? factory[block]).toLowerCase()
    && (first.brightness[block] ?? 100) === (second.brightness[block] ?? 100));
}

function ColorSchemePicker({ shape, palette, defaults, onChange, onCustom }: {
  shape: KeyShape;
  palette: KeyPalette;
  defaults: KeyPalette;
  onChange: (palette: KeyPalette) => void;
  onCustom: () => void;
}) {
  const effective = paletteColors(shape, palette);
  const isDefault = samePalette(shape, palette, defaults);
  const schemes = shape === "Sculpted" || shape === "Square" || shape === "RTC"
    ? [retroIvory, ...colorSchemes] : colorSchemes;
  const selected = isDefault ? "default" : schemes.find((scheme) =>
    blockKeys.every((block) => effective[block].toLowerCase() === scheme.colors[block]))?.data ?? "custom";
  const choices = [
    { data: "default", label: "Default", colors: paletteColors(shape, defaults) },
    ...schemes,
    { data: "custom", label: "Custom", colors: effective },
  ];
  return (
    <SettingPicker
      label="Color scheme"
      selectedOption={selected}
      rgOptions={choices.map(({ data, label, colors }) => ({
        data, label: (
          <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
            <span>{label}</span>
            <PaletteSwatches colors={colors} />
          </span>
        ),
      }))}
      onChange={({ data }) => {
        if (data === "custom") onCustom();
        else if (data === "default") onChange(defaults);
        else {
          const scheme = schemes.find((option) => option.data === data);
          if (scheme) onChange({ colors: scheme.colors, brightness: {} });
        }
      }}
    />
  );
}

function ColorSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, width: "max-content" }}>
      <span aria-hidden="true" style={{
        width: 12, height: 12, boxSizing: "border-box", flexShrink: 0, background: color,
        border: "1px solid #ffffff55", borderRadius: 3,
      }} />
      <span style={{ whiteSpace: "nowrap" }}>{label}</span>
    </span>
  );
}

function shadeColor(color: string, brightness: number) {
  const target = brightness < 100 ? 0 : 255;
  const amount = Math.abs(brightness - 100) / 100;
  return "#" + [1, 3, 5].map((index) => {
    const channel = parseInt(color.slice(index, index + 2), 16);
    return Math.round(channel * (1 - amount) + target * amount).toString(16).padStart(2, "0");
  }).join("");
}

function ColorEditor({ label, value, presets, advanced, brightness = 100, onBrightnessChange,
  onExpand, onSelect, onRestore, isDefault }: {
  label: string;
  value: string;
  presets: ColorPreset[];
  advanced: boolean;
  brightness?: number;
  onBrightnessChange?: (brightness: number) => void;
  onExpand: (expanded: boolean) => void;
  onSelect: (value: string) => void;
  onRestore: () => void;
  isDefault: boolean;
}) {
  const rgbTrigger = useRef<HTMLDivElement>(null);
  const preset = presets.find((preset) => preset.data === value);
  const color = preset ? preset.color ?? "#20252e" : value;
  const channels = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
  const latestChannels = useRef(channels);
  latestChannels.current = channels;

  return (
    <>
      <PanelSectionRow>
        <SettingPicker
          label={label}
          selectedOption={preset?.data ?? "custom"}
          rgOptions={[
            ...presets.map(({ data, label, color, brightness: presetBrightness = brightness }) => ({
              data, label: color ? <ColorSwatch color={shadeColor(color, presetBrightness)} label={label} /> : label,
            })),
            { data: "custom", label: <ColorSwatch color={shadeColor(color, brightness)} label="Custom" /> },
          ]}
          onChange={(option) => {
            if (option.data === "custom") onExpand(true);
            else onSelect(option.data);
          }}
        />
      </PanelSectionRow>
      {onBrightnessChange && (
        <PanelSectionRow>
          <SliderField label="Brightness" value={brightness} min={0} max={200}
            step={5} showValue valueSuffix="%" resetValue={100} onChange={onBrightnessChange} />
        </PanelSectionRow>
      )}
      <Focusable className="mk-panel-group" flow-children="column" onCancelButton={advanced ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        onExpand(false);
        rgbTrigger.current?.querySelector("button")?.focus();
      } : undefined} onCancelActionDescription={advanced ? "Close RGB" : undefined}>
        <div ref={rgbTrigger}>
          <PanelSectionRow>
            <SettingsButton label="Custom RGB" expanded={advanced} arrow={advanced ? "▴" : "▾"}
              value={(!preset || preset.color || advanced) &&
                <ColorSwatch color={shadeColor(color, brightness)} label={color.toUpperCase()} />}
              onClick={() => onExpand(!advanced)}
            />
          </PanelSectionRow>
        </div>
        {advanced && rgbChannels.map((label, index) => (
          <PanelSectionRow key={label}>
            <SliderField label={label} min={0} max={255} step={1} showValue
              value={channels[index]}
              onChange={(value) => {
                const next = [...latestChannels.current];
                if (next[index] === value) return;
                next[index] = value;
                latestChannels.current = next;
                onSelect("#" + next.map((channel) => channel.toString(16).padStart(2, "0")).join(""));
              }}
            />
          </PanelSectionRow>
        ))}
      </Focusable>
      <PanelSectionRow>
        <SettingsButton label="Restore default" arrow="↺" quieter disabled={isDefault} onClick={onRestore} />
      </PanelSectionRow>
    </>
  );
}

function BlockColorEditor({ shape, palette, defaults, onChange }: {
  shape: KeyShape;
  palette: KeyPalette;
  defaults: KeyPalette;
  onChange: (palette: KeyPalette) => void;
}) {
  const [editor, setEditor] = useState(colorEditorState);
  const { block } = editor;
  const blocks = profiles[shape].colors;
  const blockOptions = blockKeys.map((key) => ({ data: key, label: blocks[key].label }));
  const factoryColor = blocks[block].color;
  const color = (palette.colors[block] ?? factoryColor).toLowerCase();
  const brightness = palette.brightness[block] ?? 100;
  const defaultColor = (defaults.colors[block] ?? factoryColor).toLowerCase();
  const defaultBrightness = defaults.brightness[block] ?? 100;
  const isDefault = color === defaultColor && brightness === defaultBrightness;

  function edit(patch: Partial<typeof editor>) {
    colorEditorState = { ...editor, ...patch };
    setEditor(colorEditorState);
  }

  function changeBlock(nextColor: string, nextBrightness: number) {
    const colors = { ...palette.colors, [block]: nextColor };
    const brightnessByBlock = { ...palette.brightness };
    if (nextBrightness === 100) delete brightnessByBlock[block];
    else brightnessByBlock[block] = nextBrightness;
    onChange({ colors, brightness: brightnessByBlock });
  }

  return (
    <>
      <PanelSectionRow>
        <SettingPicker label="Color block" selectedOption={block} rgOptions={blockOptions}
          onChange={(option) => edit({ block: option.data })}
        />
      </PanelSectionRow>
      <ColorEditor
        label="Block color"
        value={isDefault ? "default" : color}
        presets={[{ data: "default", label: "Default", color: defaultColor, brightness: defaultBrightness }, ...colorPresets]}
        advanced={editor.advanced}
        brightness={brightness}
        onBrightnessChange={shape === "Wukong" ? (value) => changeBlock(color, value) : undefined}
        onExpand={(advanced) => edit({ advanced })}
        onSelect={(value) => value === "default"
          ? changeBlock(defaultColor, defaultBrightness) : changeBlock(value, brightness)}
        onRestore={() => changeBlock(defaultColor, defaultBrightness)}
        isDefault={isDefault}
      />
    </>
  );
}

function FocusColorEditor({ color, brightness, onChange, onBrightnessChange, onRestore }: {
  color: string;
  brightness: number;
  onChange: (color: string) => void;
  onBrightnessChange: (brightness: number) => void;
  onRestore: () => void;
}) {
  const [advanced, setAdvanced] = useState(focusRgbExpanded);
  return (
    <ColorEditor
      label="Focus color"
      brightness={brightness}
      onBrightnessChange={onBrightnessChange}
      value={color.startsWith("#") ? color.toLowerCase() : color}
      presets={focusPresets}
      advanced={advanced}
      onExpand={(expanded) => {
        focusRgbExpanded = expanded;
        setAdvanced(expanded);
      }}
      onSelect={onChange}
      onRestore={onRestore}
      isDefault={color === "Purple" && brightness === 100}
    />
  );
}

function BackgroundColorEditor({ color, onChange }: {
  color: string | null;
  onChange: (color: string | null) => void;
}) {
  const [advanced, setAdvanced] = useState(backgroundRgbExpanded);
  return (
    <ColorEditor
      label="Background color"
      value={color ?? "default"}
      presets={backgroundPresets}
      advanced={advanced}
      onExpand={(expanded) => {
        backgroundRgbExpanded = expanded;
        setAdvanced(expanded);
      }}
      onSelect={(value) => onChange(value === "default" ? null : value)}
      onRestore={() => onChange(null)}
      isDefault={color === null}
    />
  );
}

const colorViewOrder = ["blocks", "focus", "background"] as const;
type ColorView = (typeof colorViewOrder)[number];
let lastColorView: ColorView | undefined;

function Content({ bundleVersion }: { bundleVersion: string }) {
  const [colorView, setColorView] = useState(lastColorView);
  const colorNavigation = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<ColorView | "keyboard" | null>(null);
  const themePicker = useRef<HTMLDivElement>(null);
  const purchaseOptions = useRef<HTMLDivElement>(null);
  const focusThemeOnUnlock = useRef(false);

  function openColors(view?: ColorView, event?: CustomEvent) {
    event?.preventDefault();
    event?.stopPropagation();
    returnFocus.current = view ? "keyboard" : colorView ?? "focus";
    lastColorView = view;
    setOpenPicker(undefined);
    setColorView(view);
  }

  useEffect(() => {
    if (!returnFocus.current) return;
    const index = returnFocus.current === "keyboard" ? 0 : colorViewOrder.indexOf(returnFocus.current);
    returnFocus.current = null;
    colorNavigation.current?.querySelectorAll("button")[index]?.focus();
  }, [colorView]);

  const [settings, setSettings] = useState<Settings>();
  const [access, setAccess] = useState<Access>();
  const [premiumPreview, setPremiumPreview] = useState<KeyShape>();
  const [openPicker, setOpenPicker] = useState<string>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  const desired = useRef<Settings | undefined>(undefined);
  const saved = useRef<Settings | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;

    void pendingWrite.then(() => Promise.all([readSettings(), getAccess()])).then(
      ([stored, access]) => {
        if (cancelled) return;
        const initial = normalizeSettings(stored);
        desired.current = initial;
        saved.current = initial;
        setSettings(initial);
        setAccess(access);
      },
      () => {
        if (!cancelled) setError("Could not load keyboard settings.");
      },
    );

    return () => {
      mounted.current = false;
      cancelled = true;
    };
  }, [reload]);

  function showActivatedPurchase(nextAccess: Access, stored: StoredSettings) {
    const options = purchaseOptions.current;
    focusThemeOnUnlock.current = Boolean(options?.contains(options.ownerDocument.activeElement));
    setAccess(nextAccess);
    setPremiumPreview(undefined);
    if (desired.current !== saved.current) return;
    const initial = normalizeSettings(stored);
    desired.current = initial;
    saved.current = initial;
    setSettings(initial);
  }

  useEffect(() => {
    if (access?.active && focusThemeOnUnlock.current) {
      focusThemeOnUnlock.current = false;
      themePicker.current?.querySelector("button")?.focus();
    }
  }, [access?.active]);

  useEffect(() => {
    if (!access?.pending && !access?.renewing) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await getAccess();
        if (canceled) return;
        if (next.active && !next.renewing) {
          await pendingWrite;
          const stored = await readSettings();
          if (!canceled) showActivatedPurchase(next, stored);
          return;
        }
        if (!next.pending && !next.renewing) {
          setAccess(next);
          return;
        }
      } catch {
        // Keep checking after a brief loss of the Decky connection.
      }
      if (!canceled) timer = setTimeout(() => void refresh(), 1500);
    }
    timer = setTimeout(() => void refresh(), 1500);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [access?.pending, access?.renewing]);

  function update(patch: Partial<Settings>) {
    if (!desired.current) return;
    const next = { ...desired.current, ...patch };
    desired.current = next;
    setSettings(next);
    setError(undefined);

    void saveSettings(patch).then(
      (result) => {
        if (!result) return;
        saved.current = result;
        if (desired.current !== next) return;
        desired.current = result;
        if (mounted.current) setSettings(result);
      },
      () => {
        if (desired.current !== next) return;
        desired.current = saved.current;
        if (mounted.current) {
          setSettings(saved.current);
          setError(patch.enabled ? "Could not enable. Turn off the other edition if it is running." : "Could not save keyboard settings.");
        }
      },
    );
  }

  if (!settings || !access) {
    return (
      <PanelSection spinner={!error}>
        {error && (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              description={error}
              onClick={() => {
                setError(undefined);
                setReload((attempt) => attempt + 1);
              }}
            >
              Retry
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>
    );
  }

  const shape = settings.shape;
  const locked = new Set(access.locked);
  const backgroundColor = settings.background_color?.toLowerCase() ?? null;
  const backgroundLabel = backgroundPresets.find(({ data }) => data === backgroundColor)?.label
    ?? backgroundColor?.toUpperCase() ?? "Theme default";
  const keyColors = (shape === "Square" ? settings.square_block_colors
    : shape === "Sculpted" ? settings.block_colors : settings.style_block_colors?.[shape]) ?? {};
  const palette: KeyPalette = {
    colors: keyColors,
    brightness: shape === "Wukong" ? settings.wukong_block_brightness ?? {} : {},
  };
  const defaults = (shape === "Wukong" ? settings.wukong_default_palette : null) ?? factoryPalette;
  const isDefaultPalette = samePalette(shape, palette, defaults);

  function updateKeyColors({ colors, brightness }: KeyPalette) {
    const defaults = defaultColors(shape);
    const overrides: BlockColors = {};
    for (const block of blockKeys) {
      const color = colors[block];
      if (color && color.toLowerCase() !== defaults[block].toLowerCase()) overrides[block] = color;
    }
    if (shape === "Square") {
      update({ square_block_colors: overrides });
    } else if (shape === "Sculpted") {
      update({ block_colors: overrides });
    } else {
      update({
        style_block_colors: { ...desired.current?.style_block_colors, [shape]: overrides },
        ...(shape === "Wukong" ? { wukong_block_brightness: brightness } : {}),
      });
    }
  }
  const preview = settings.preview_open && (
    <PanelSectionRow>
      <Preview settings={settings} showFocus={colorView === "focus"} />
    </PanelSectionRow>
  );

  return (
    <PickerContext.Provider value={{ openPicker, setOpenPicker }}>
      <PanelSection>
        <style>{panelCss}</style>
        <Focusable id="masterkeyboard-controls" className="mk-panel" flow-children="column"
          onCancelButton={colorView ? (event) => openColors(undefined, event) : undefined}
          onCancelActionDescription={colorView ? "Back to keyboard" : undefined}>
          {colorView && (
            <div ref={colorNavigation}>
              <PanelSectionRow>
                <SettingsButton label="‹ Keyboard" onClick={() => openColors()} />
              </PanelSectionRow>
            </div>
          )}
          {colorView && preview}
          {colorView === "focus" ? (
            <FocusColorEditor
              color={settings.focus_color}
              brightness={settings.focus_brightness ?? 100}
              onChange={(focus_color) => update({ focus_color })}
              onBrightnessChange={(focus_brightness) => update({ focus_brightness })}
              onRestore={() => update({ focus_color: "Purple", focus_brightness: 100 })}
            />
          ) : colorView === "blocks" ? (
            <>
              <BlockColorEditor shape={shape} palette={palette} defaults={defaults} onChange={updateKeyColors} />
              {shape === "Wukong" && (
                <PanelSectionRow>
                  <SettingsButton label="Save as Wukong default" disabled={isDefaultPalette}
                    value={settings.wukong_default_palette && isDefaultPalette ? "Saved" : undefined}
                    onClick={() => update({ wukong_default_palette: palette })} />
                </PanelSectionRow>
              )}
            </>
          ) : colorView === "background" ? (
            <BackgroundColorEditor color={backgroundColor}
              onChange={(background_color) => update({ background_color })} />
          ) : (
            <>
              <div className="mk-panel-group">
                <PanelSectionRow>
                  <ToggleField
                    label={<span className="mk-enabled-label">Enabled{access.active && <ProBadge />}</span>}
                    checked={settings.enabled}
                    bottomSeparator="none"
                    onChange={(enabled) => update({ enabled })}
                  />
                </PanelSectionRow>
                <div ref={themePicker}>
                  <PanelSectionRow>
                    <SettingPicker
                      label="Key shape"
                      selectedOption={premiumPreview ?? shape}
                      rgOptions={shapeOptions.map((option) => ({ ...option, locked: locked.has(option.data) }))}
                      onChange={(option) => {
                        if (locked.has(option.data)) setPremiumPreview(option.data);
                        else {
                          setPremiumPreview(undefined);
                          update({ shape: option.data });
                        }
                      }}
                    />
                  </PanelSectionRow>
                </div>
                <PanelSectionRow>
                  <ToggleField
                    label="Preview"
                    checked={settings.preview_open}
                    bottomSeparator="none"
                    onChange={(preview_open) => update({ preview_open })}
                  />
                </PanelSectionRow>
                {premiumPreview ? (
                  <PanelSectionRow><PremiumPreview key={premiumPreview} shape={premiumPreview} /></PanelSectionRow>
                ) : preview}
              </div>
              {access.public && !access.active && (
                <div ref={purchaseOptions}>
                  <PanelSectionRow>
                    <PurchasePanel access={access} onCheckout={setAccess} onActivated={showActivatedPurchase} />
                  </PanelSectionRow>
                </div>
              )}
              <section className="mk-panel-group" aria-labelledby="mk-appearance">
                <h2 className="mk-section-title" id="mk-appearance">Appearance</h2>
                {!access.colors_locked && (
                  <PanelSectionRow>
                    <ColorSchemePicker shape={shape} palette={palette} defaults={defaults} onChange={updateKeyColors}
                      onCustom={() => openColors("blocks")} />
                  </PanelSectionRow>
                )}
                <div className="mk-panel-group" ref={colorNavigation}>
                  <PanelSectionRow>
                    {access.colors_locked ? (
                      <SettingsButton label="Key colors" value={<PremiumBadge />}
                        onClick={() => purchaseOptions.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
                      />
                    ) : (
                      <SettingsButton label="Key colors" arrow="›" onClick={() => openColors("blocks")}
                        value={<PaletteSwatches colors={paletteColors(shape, palette)} />}
                      />
                    )}
                  </PanelSectionRow>
                  <PanelSectionRow>
                    <SettingsButton label="Focus color" arrow="›"
                      value={<ColorSwatch
                        color={shadeColor(
                          focusPresets.find((preset) => preset.data === settings.focus_color)?.color ?? settings.focus_color,
                          settings.focus_brightness ?? 100,
                        )}
                        label={`${settings.focus_brightness ?? 100}%`}
                      />}
                      onClick={() => openColors("focus")}
                    />
                  </PanelSectionRow>
                  <PanelSectionRow>
                    <SettingsButton label="Background color" arrow="›"
                      value={backgroundColor
                        ? <ColorSwatch color={backgroundColor} label={backgroundLabel} />
                        : backgroundLabel}
                      onClick={() => openColors("background")}
                    />
                  </PanelSectionRow>
                </div>
              </section>
              <section className="mk-panel-group" aria-labelledby="mk-layout-sound">
                <h2 className="mk-section-title" id="mk-layout-sound">Layout &amp; sound</h2>
                <PanelSectionRow>
                  <SliderField
                    label="Keyboard height"
                    bottomSeparator="none"
                    value={settings.height}
                    onChange={(value) => {
                      const height = keyboardHeights.find((step) => step === value);
                      if (height !== undefined) update({ height });
                    }}
                    min={-20}
                    max={8}
                    step={4}
                    notchCount={keyboardHeights.length}
                    notchTicksVisible
                    showValue
                    valueSuffix=" px"
                    resetValue={0}
                  />
                </PanelSectionRow>
                <PanelSectionRow>
                  <SliderField
                    label="Background opacity"
                    bottomSeparator="none"
                    min={0}
                    max={100}
                    step={5}
                    showValue
                    valueSuffix="%"
                    value={100 - (settings.background_transparency ?? (settings.transparent ? 50 : 0))}
                    resetValue={100}
                    onChange={(opacity) => update({
                      background_transparency: 100 - opacity,
                      transparent: opacity < 100,
                    })}
                  />
                </PanelSectionRow>
                <PanelSectionRow>
                  <SettingPicker
                    label="Typing sound"
                    selectedOption={settings.typing_sound_style ?? (settings.typing_sound === false ? "Steam" : "Clicky")}
                    rgOptions={typingSounds.map((sound) => ({ data: sound, label: sound }))}
                    onChange={(option) => update({ typing_sound_style: option.data })}
                  />
                </PanelSectionRow>
                <PanelSectionRow>
                  <ToggleField
                    label="Typing preview"
                    description={access.active
                      ? "Drag Space to move the cursor. Hold Shift and drag to select text."
                      : "Show text above the keyboard. Cursor and selection gestures are included with Premium."}
                    bottomSeparator="none"
                    checked={settings.typing_preview ?? false}
                    onChange={(typing_preview) => update({ typing_preview })}
                  />
                </PanelSectionRow>
              </section>
              <section className="mk-panel-group" aria-labelledby="mk-typing-shortcuts">
                <h2 className="mk-section-title" id="mk-typing-shortcuts">Typing shortcuts</h2>
                <PanelSectionRow>
                  <ToggleField
                    label={<span className="mk-enabled-label">Split keyboard{!access.active && <PremiumBadge />}</span>}
                    description={access.active
                      ? "Open with two thumb-sized key groups. Switch back to Full above the keyboard."
                      : "Two thumb-sized key groups · Premium"}
                    disabled={!access.active}
                    bottomSeparator="none"
                    checked={access.active && (settings.split_keyboard ?? false)}
                    onChange={(split_keyboard) => update({ split_keyboard })}
                  />
                </PanelSectionRow>
                <PanelSectionRow>
                  <ToggleField
                    label="Double-tap Shift to lock"
                    description="A single tap shifts the next letter."
                    bottomSeparator="none"
                    checked={settings.shift_double_tap_lock ?? true}
                    onChange={(shift_double_tap_lock) => update({ shift_double_tap_lock })}
                  />
                </PanelSectionRow>
                <PanelSectionRow>
                  <ToggleField
                    label="Double-space for period"
                    description="Tap Space twice to insert a period and a space."
                    bottomSeparator="none"
                    checked={settings.double_space_period ?? true}
                    onChange={(double_space_period) => update({ double_space_period })}
                  />
                </PanelSectionRow>
                <PanelSectionRow>
                  <ToggleField
                    label="Auto-capitalization"
                    description="Capitalize the next letter after a period and a space."
                    bottomSeparator="none"
                    checked={settings.sentence_capitalization ?? true}
                    onChange={(sentence_capitalization) => update({ sentence_capitalization })}
                  />
                </PanelSectionRow>
              </section>
              {access.public && (
                <div className="mk-panel-group">
                  <Updates bundleVersion={bundleVersion} />
                  {access.plasma_install && <PlasmaSetup />}
                </div>
              )}
              <div className="mk-panel-group">
                {access.public && <PanelSectionRow><ContactSupport /></PanelSectionRow>}
              </div>
            </>
          )}
        </Focusable>
        {error && (
          <PanelSectionRow>
            <div role="alert">{error}</div>
          </PanelSectionRow>
        )}
      </PanelSection>
    </PickerContext.Provider>
  );
}

export default definePlugin(() => ({
  name: plugin.name,
  titleView: <div className={staticClasses.Title}>{plugin.name}</div>,
  content: <Content bundleVersion={installedVersion} />,
  icon: <KeyboardIcon />,
}));
