import { RouterContextProvider } from "react-router";
import { describe, expect, test } from "vitest";

import { configContext, loadRuntimeConfig } from "../app/lib/config.server.ts";
import { createLoadContext } from "../server/app.ts";

/** 検証を通る環境変数一式。 */
const environment = {
  POWER_MANAGER_CONFIG_PATH: "/etc/power-manager/config.json",
  POWER_MANAGER_PORT: "8080",
  POWER_MANAGER_PUBLIC_ORIGIN: "https://power.example.ts.net",
  POWER_MANAGER_AUTH_USERNAME: "admin",
  POWER_MANAGER_AUTH_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA",
  POWER_MANAGER_SSH_IDENTITY_FILE: "/run/secrets/power-manager/id_ed25519",
  POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: "/etc/power-manager/known_hosts",
};

describe("load context", () => {
  test("検証済みの実行時設定を loader/action から参照できる", () => {
    const runtime = loadRuntimeConfig(environment);
    const context = createLoadContext(runtime);

    expect(context.get(configContext)).toBe(runtime);
    expect(context.get(configContext).configPath).toBe("/etc/power-manager/config.json");
    expect(context.get(configContext).publicOrigin).toBe("https://power.example.ts.net");
  });

  test("設定を載せていない context からの参照は失敗する", () => {
    expect(() => new RouterContextProvider().get(configContext)).toThrow();
  });
});
