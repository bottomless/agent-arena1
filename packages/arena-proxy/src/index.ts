import { resolve } from "node:path";

import { ArenaProxyService } from "./service.js";
import { createArenaProxyServer } from "./server.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const host = process.env.ARENA_PROXY_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.ARENA_PROXY_PORT || 6770);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("ARENA_PROXY_PORT must be a valid port");
}

const service = new ArenaProxyService({
  apiToken: requireEnv("ARENA_API_TOKEN"),
  openRouterApiKey: requireEnv("OPENROUTER_API_KEY"),
  dataDir: resolve(process.env.ARENA_DATA_DIR?.trim() || ".arena-data"),
  fallbackDeepSeekModel:
    process.env.ARENA_DEEPSEEK_V4_PRO_MODEL?.trim() || "deepseek/deepseek-v4-pro",
});

createArenaProxyServer(service).listen(port, host, () => {
  process.stdout.write(`Paseo Arena proxy listening on http://${host}:${port}\n`);
});
