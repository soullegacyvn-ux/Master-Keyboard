# Decky Loader API

Masterkeyboard uses `@decky/api` 1.1.3 by the SteamDeckHomebrew Team under the GNU Lesser General Public License, version 2.1. See the accompanying [LICENSE](LICENSE) for its terms.

The source in `src/`, package metadata, and license are verbatim from the [npm release](https://registry.npmjs.org/@decky/api/-/api-1.1.3.tgz). The TypeScript configuration and dependency lockfile are from the [source revision d1b7f16](https://github.com/SteamDeckHomebrew/loader-api/tree/d1b7f16070777a0ada939cbacd3606eeba0574f5).

## Runtime module

`dist/index.js` imports `callable` and `definePlugin` from `./decky-api.js`. The application’s Rollup configuration builds this library module from `@decky/api`, supplying the Masterkeyboard manifest and exporting the SDK functions the application uses.

To use a compatible replacement, replace only `dist/decky-api.js` in the installed plugin. Keep the same named ESM exports and Decky connection behavior. Start a fresh Steam session after replacing the file so the browser loads the replacement module.

## Building from source

To compile the supplied SDK source, run the following from this directory.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsc -p tsconfig.json
```

To produce a browser module from a locally modified SDK, use that built SDK package as the `@decky/api` dependency in a working copy of Masterkeyboard. Run `pnpm build` there and take `dist/decky-api.js` from the build output.
