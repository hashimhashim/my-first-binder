import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";

// In the container the API base is injected at runtime via window.__API_BASE__
// (see index.html); in dev it proxies /api to the backend.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {"/api": {target: "http://localhost:8000", changeOrigin: true}},
  },
});
