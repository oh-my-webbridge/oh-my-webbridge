import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// Lists the npm modules in the bundle; scripts/build.mjs copies their licenses.
const bundledModules: Plugin = {
  name: "omw-bundled-modules",
  generateBundle() {
    const modules = [...this.getModuleIds()].filter((id) => id.includes("/node_modules/")).sort();
    this.emitFile({
      type: "asset",
      fileName: "bundled-modules.json",
      source: `${JSON.stringify(modules, null, 2)}\n`,
    });
  },
};

// Builds the extension pages. scripts/build.mjs copies the output into the
// Chrome and Firefox extension directories.
export default defineConfig({
  root,
  base: "./",
  plugins: [react(), tailwindcss(), bundledModules],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@ext": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../../dist/extension-ui", import.meta.url)),
    emptyOutDir: true,
    target: ["chrome156", "firefox153"],
    modulePreload: false,
    rollupOptions: {
      input: { popup: `${root}popup.html`, app: `${root}app.html` },
    },
  },
});
