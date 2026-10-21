import { describe, expect, test } from "vitest";

import { loadRuntimeConfig } from "../app/lib/config.server.ts";

/** すべての必須環境変数が揃った状態。個別のテストで必要な項目だけ上書きする。 */
function validEnvironment(): Record<string, string> {
  return {
    POWER_MANAGER_CONFIG_PATH: "/etc/power-manager/config.json",
    POWER_MANAGER_PORT: "8080",
    POWER_MANAGER_PUBLIC_ORIGIN: "https://power.example.ts.net",
    POWER_MANAGER_AUTH_USERNAME: "admin",
    POWER_MANAGER_AUTH_PASSWORD_HASH:
      "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$aGFzaHZhbHVl",
    POWER_MANAGER_SSH_IDENTITY_FILE: "/run/secrets/power-manager/id_ed25519",
    POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: "/etc/power-manager/known_hosts",
  };
}

describe("実行時設定", () => {
  test("ポートを数値として読む", () => {
    expect(loadRuntimeConfig(validEnvironment()).port).toBe(8080);
  });

  test("必須の環境変数が欠落していれば変数名付きで拒否する", () => {
    const environment = validEnvironment();
    delete environment.POWER_MANAGER_PORT;
    expect(() => loadRuntimeConfig(environment)).toThrow(/POWER_MANAGER_PORT/);
  });

  test.each(["0", "65536", "abc", "8080.5"])("範囲外・不正なポート %s を拒否する", (value) => {
    expect(() =>
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_PORT: value }),
    ).toThrow(/POWER_MANAGER_PORT/);
  });
});
