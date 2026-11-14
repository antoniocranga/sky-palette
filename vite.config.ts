import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), cloudflare({ viteEnvironment: { name: "worker" } })],
  environments: {
    worker: {
      build: { sourcemap: true },
    },
  },
  build: {
    target: "es2022",
    cssTarget: "es2022",
  },
});
