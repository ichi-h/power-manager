import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { ServerConfigStore } from "../src/config";
import type { RuntimeConfig } from "../src/model";
import { ServerOperations } from "../src/services";

const runtime: RuntimeConfig = {
  configPath: "/tmp/power-manager-test-servers.json", port: 8080, publicOrigin: "https://power.example",
  authUsername: "admin", authPasswordHash: await Bun.password.hash("secret", { algorithm: "argon2id" }),
  sshIdentityFile: "/tmp/key", sshKnownHostsFile: "/tmp/known_hosts",
};
await Bun.write(runtime.configPath, JSON.stringify({ version: 1, servers: [{ id: "nas", name: "NAS", macAddress: "00:11:22:33:44:55", wol: {}, ssh: { host: "127.0.0.1", user: "power-manager", shutdownCommand: "poweroff" } }] }));
const store = new ServerConfigStore(runtime.configPath);
await store.reload();
const app = createApp(runtime, store, new ServerOperations(runtime));
const authorization = `Basic ${btoa("admin:secret")}`;

test("認証なしの画面要求を拒否する", async () => {
  const response = await app.request("http://localhost/");
  expect(response.status).toBe(401);
  expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
});

test("変更操作の不正な Origin を拒否する", async () => {
  const response = await app.request("http://localhost/servers/nas/wake", { method: "POST", headers: { Authorization: authorization, Origin: "https://invalid.example" } });
  expect(response.status).toBe(403);
});
