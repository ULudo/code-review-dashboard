import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../src/git_review_dashboard/static",
    emptyOutDir: true,
    sourcemap: false,
  },
});
