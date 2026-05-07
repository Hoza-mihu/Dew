import { defineConfig, loadEnv } from "vite";
import path from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_DEV_API_TARGET || "http://localhost:3000";

  return {
    root: path.resolve(__dirname, "public"),
    publicDir: false,
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    server: {
      port: 5173,
      fs: {
        allow: [path.resolve(__dirname, "src"), path.resolve(__dirname)],
      },
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    preview: {
      port: 4173,
      strictPort: false,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: path.resolve(__dirname, "dist"),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, "public/index.html"),
          login: path.resolve(__dirname, "public/login.html"),
          signup: path.resolve(__dirname, "public/signup.html"),
          scrollSequence: path.resolve(
            __dirname,
            "public/scroll-sequence.html",
          ),
          splineDemo: path.resolve(__dirname, "public/spline-demo.html"),
        },
      },
    },
  };
});
