type PluginVersion = { name: string; version?: string };
type LoadedPlugin = PluginVersion & { content?: { props?: { bundleVersion?: string } } };
type InstallPrompt = (name: string, version: string, requestId: string, hash: string, type: number) => void;

type DeckyRuntime = {
  DeckyBackend?: {
    call<T>(route: string, ...args: (string | number)[]): Promise<T>;
    eventListeners?: Map<string, Set<InstallPrompt>>;
    addEventListener(event: string, listener: InstallPrompt): void;
    removeEventListener(event: string, listener: InstallPrompt): void;
  };
  DeckyPluginLoader?: {
    toaster?: {
      toast(options: { title: string; body: string; duration: number; playSound: boolean }): unknown;
    };
    deckyState?: {
      publicState(): {
        activePlugin: LoadedPlugin | null;
        plugins: LoadedPlugin[];
        versionInfo?: { current?: string } | null;
      };
      setActivePlugin(name: string): void;
    };
  };
};

function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Decky took too long to respond")), milliseconds);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

export async function installStagedUpdate(name: string, version: string, artifact: string, hash: string) {
  const { DeckyBackend: backend, DeckyPluginLoader: loader } = window as Window & DeckyRuntime;
  if (!backend) throw new Error("Decky installer is unavailable");

  const installType = 2;
  const event = "loader/add_plugin_install_prompt";
  const state = loader?.deckyState;
  const versionInfo = state?.publicState().versionInfo?.current?.replace(/^v/, "");
  const listeners = backend.eventListeners instanceof Map ? backend.eventListeners.get(event) : undefined;
  const nativePrompts = listeners instanceof Set
    ? [...listeners].filter((listener) => listener.name === "bound addPluginInstallPrompt")
    : [];
  const startInstall = () => backend.call<void>("utilities/install_plugin", artifact, name, version, hash, installType);

  if (!state || versionInfo !== "3.3.1" || nativePrompts.length !== 1) {
    await withTimeout(startInstall(), 5000);
    return "confirm";
  }

  // The Install update button is the confirmation for this verified local ZIP.
  // Scope Decky's prompt override to its matching request. Forward all other prompts.
  const [nativePrompt] = nativePrompts;
  let captured = false;
  let acceptRequest: (requestId: string) => void = () => undefined;
  const prompt = new Promise<string>((resolve) => { acceptRequest = resolve; });
  const capture: InstallPrompt = (requestedName, requestedVersion, id, digest, type) => {
    if (!captured && requestedName === name && requestedVersion === version && digest === hash && type === installType) {
      captured = true;
      acceptRequest(id);
    } else {
      nativePrompt(requestedName, requestedVersion, id, digest, type);
    }
  };

  backend.removeEventListener(event, nativePrompt);
  backend.addEventListener(event, capture);
  let requestId: string;
  try {
    [requestId] = await withTimeout(Promise.all([prompt, startInstall()]), 5000);
  } finally {
    backend.removeEventListener(event, capture);
    backend.addEventListener(event, nativePrompt);
  }

  await withTimeout(backend.call<void>("utilities/confirm_plugin_install", requestId), 25000);
  const installed = await withTimeout(backend.call<PluginVersion[]>("loader/get_plugins"), 5000);
  if (!installed.some((plugin) => plugin.name === name && plugin.version === version)) {
    throw new Error("Decky did not load the updated plugin");
  }

  // Decky can retain a reference to the old panel after importing the new frontend.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { activePlugin, plugins } = state.publicState();
    const updatedPlugin = plugins.find((plugin) =>
      plugin.name === name && plugin.version === version && plugin.content?.props?.bundleVersion === version);
    if (updatedPlugin) {
      if (activePlugin?.name === name && activePlugin !== updatedPlugin) state.setActivePlugin(name);
      loader?.toaster?.toast({ title: name, body: `Updated to v${version}`, duration: 3000, playSound: false });
      return "installed";
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Decky did not refresh the updated panel");
}
