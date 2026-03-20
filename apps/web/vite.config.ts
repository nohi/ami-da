import { defineConfig } from "vite";

const devPortRaw = process.env.VITE_DEV_PORT ?? "5173";
const devPort = Number.parseInt(devPortRaw, 10);
if (!Number.isInteger(devPort) || devPort < 1 || devPort > 65535) {
  throw new Error(`Invalid VITE_DEV_PORT: ${devPortRaw}`);
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  server: {
    host: true,
    port: devPort,
  },
});
