import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Zama relayer SDK loads FHE crypto as WASM from a CDN and uses web workers.
// The COOP/COEP headers below enable the cross-origin isolation some browsers require.
export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    exclude: ["@zama-fhe/relayer-sdk"],
  },
  define: {
    global: "globalThis",
  },
});
