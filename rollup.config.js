import deckyPlugin from "@decky/rollup";

const config = deckyPlugin({});

export default {
  ...config,
  output: {
    ...config.output,
    chunkFileNames: "[name].js",
    minifyInternalExports: false,
    manualChunks: {
      "decky-api": ["@decky/api"],
    },
    banner: (chunk) => chunk.name === "decky-api"
      ? "/*! @decky/api 1.1.3 by the SteamDeckHomebrew Team, LGPL-2.1. Source and license in assets/third-party/decky-api/. */"
      : "",
  },
};
