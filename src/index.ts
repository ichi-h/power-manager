import { loadRuntimeConfig, ServerConfigStore } from "./config";
import { createApp } from "./app";
import { ServerOperations } from "./services";

const configurationErrorExitCode = 78;
try {
  const runtime = loadRuntimeConfig();
  const store = new ServerConfigStore(runtime.configPath);
  await store.reload();
  const app = createApp(runtime, store, new ServerOperations(runtime));
  Bun.serve({ hostname: "127.0.0.1", port: runtime.port, fetch: app.fetch });
  console.log(JSON.stringify({ event: "started", port: runtime.port }));
} catch (error) {
  console.error(JSON.stringify({ event: "startup_failed", code: "invalid_configuration", reason: error instanceof Error ? error.message : "unknown" }));
  process.exit(configurationErrorExitCode);
}
