import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 3000,
    strictPort: true,
    host: host || '127.0.0.1',
    hmr: host
      ? { protocol: "ws", host, port: 3001 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "/api": "http://127.0.0.1:8081",
      "/health": "http://127.0.0.1:8081",
      "/previews": "http://127.0.0.1:8081",
    },
  },
}));
