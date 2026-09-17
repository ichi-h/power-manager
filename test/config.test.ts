import { describe, expect, test } from "bun:test";
import { loadRuntimeConfig, parseServerConfig } from "../src/config";

const env = { POWER_MANAGER_CONFIG_PATH: "/etc/power-manager/servers.json", POWER_MANAGER_PORT: "8080", POWER_MANAGER_PUBLIC_ORIGIN: "https://power.example", POWER_MANAGER_AUTH_USERNAME: "admin", POWER_MANAGER_AUTH_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=4$abc$def", POWER_MANAGER_SSH_IDENTITY_FILE: "/run/secrets/key", POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: "/etc/power-manager/known_hosts" };
describe("設定検証", () => {
  test("有効な環境変数を読める", () => expect(loadRuntimeConfig(env).port).toBe(8080));
  test("localhost の HTTP Originを読める", () => expect(loadRuntimeConfig({ ...env, POWER_MANAGER_PUBLIC_ORIGIN: "http://localhost:8080" }).publicOrigin).toBe("http://localhost:8080"));
  test("localhost 以外の HTTP Originを拒否する", () => expect(() => loadRuntimeConfig({ ...env, POWER_MANAGER_PUBLIC_ORIGIN: "http://power.example" })).toThrow());
  test("IP アドレスの HTTP Originを拒否する", () => expect(() => loadRuntimeConfig({ ...env, POWER_MANAGER_PUBLIC_ORIGIN: "http://127.0.0.1:8080" })).toThrow());
  test("重複IDを拒否する", () => expect(() => parseServerConfig({ version: 1, servers: [{ id: "a", name: "A", macAddress: "00:11:22:33:44:55", wol: {}, ssh: { host: "a", user: "root", shutdownCommand: "poweroff" } }, { id: "a", name: "B", macAddress: "00:11:22:33:44:56", wol: {}, ssh: { host: "b", user: "root", shutdownCommand: "poweroff" } }] })).toThrow());
});
