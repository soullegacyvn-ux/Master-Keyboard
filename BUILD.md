# Build and verify Master Keyboard for Decky

Use Node.js 24 and pnpm 9.15.9. From the root of this repository, run:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
```

Rollup creates `dist/index.js` and the replaceable `dist/decky-api.js` module. For Decky's manual installer, package `main.py`, `plugin.json`, `package.json`, `LICENSE`, `README.md`, `dist/`, `assets/`, and `py_modules/` under a single `Master Keyboard/` directory in a ZIP file.

### Compare with the distributed ZIP

Download the install ZIP and its SHA-256 file from [GitHub Releases](https://github.com/soullegacyvn-ux/Master-Keyboard/releases). Run `sha256sum -c SHA256SUMS.txt` before extracting it. Compare both JavaScript files in the unpacked `dist/` directory with the files from your build. The backend Python modules and runtime assets can be compared directly against the source tree.

The 1.2.9 build was published before the client source was added to this repository. Its two compiled JavaScript files, Python files, manifests, and runtime assets match this source byte for byte. The repository README is maintained separately from the README in that ZIP.

### What runs on the device

- The plugin uses Steam's loopback CEF interface to render the keyboard and implement local editing shortcuts. The Gamescope clipboard helper runs as the desktop user and handles only the requested shortcut in the supported focused editor.
- The six included themes work offline. Trial, purchase, and restore actions use the Master Keyboard store endpoint and a public key to verify signed theme downloads. The 24-hour trial is tied to the plugin’s installation ID and has its own signed expiry. Server-side commerce code and the paid artwork downloads are separate from this Decky client.
- The manual update action uses the Master Keyboard catalog and GitHub Releases. The optional Plasma setup action uses the separate Plasma GitHub repository and validates the SHA-256 of its package before running the installer as the desktop user.
- The support form sends the email and message entered by the user when submitted.

See [LICENSE](LICENSE) and [asset and dependency notices](assets/ASSET-SOURCES.txt) for applicable terms.
