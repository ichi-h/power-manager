import { describe, expect, test } from "vitest";

import { ConfigurationError, loadRuntimeConfig } from "../app/lib/config.server.ts";

/** すべての必須環境変数が揃った状態。個別のテストで必要な項目だけ上書きする。 */
function validEnvironment(): Record<string, string> {
  return {
    POWER_MANAGER_CONFIG_PATH: "/etc/power-manager/config.json",
    POWER_MANAGER_PORT: "8080",
    POWER_MANAGER_PUBLIC_ORIGIN: "https://power.example.ts.net",
    POWER_MANAGER_AUTH_USERNAME: "admin",
    POWER_MANAGER_AUTH_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA",
    POWER_MANAGER_SSH_IDENTITY_FILE: "/run/secrets/power-manager/id_ed25519",
    POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: "/etc/power-manager/known_hosts",
  };
}

describe("実行時設定", () => {
  test("必須の環境変数が揃っていれば検証済みの設定を返す", () => {
    const runtime = loadRuntimeConfig(validEnvironment());

    expect(runtime.port).toBe(8080);
    expect(runtime.configPath).toBe("/etc/power-manager/config.json");
    expect(runtime.publicOrigin).toBe("https://power.example.ts.net");
    expect(runtime.authUsername).toBe("admin");
    expect(runtime.sshIdentityFile).toBe("/run/secrets/power-manager/id_ed25519");
    expect(runtime.sshKnownHostsFile).toBe("/etc/power-manager/known_hosts");
    // NODE_ENV は本番既定値を持つ。環境変数ファイルでの上書きは任意。
    expect(runtime.nodeEnv).toBe("production");
  });

  test("検証失敗は ConfigurationError になる", () => {
    expect(() => loadRuntimeConfig({})).toThrow(ConfigurationError);
  });

  test.each([
    "POWER_MANAGER_CONFIG_PATH",
    "POWER_MANAGER_PORT",
    "POWER_MANAGER_PUBLIC_ORIGIN",
    "POWER_MANAGER_AUTH_USERNAME",
    "POWER_MANAGER_AUTH_PASSWORD_HASH",
    "POWER_MANAGER_SSH_IDENTITY_FILE",
    "POWER_MANAGER_SSH_KNOWN_HOSTS_FILE",
  ])("必須の %s が欠落していれば変数名付きで拒否する", (name) => {
    const environment = validEnvironment();
    delete environment[name];

    expect(() => loadRuntimeConfig(environment)).toThrow(new RegExp(name));
  });

  test.each([
    "POWER_MANAGER_CONFIG_PATH",
    "POWER_MANAGER_AUTH_USERNAME",
    "POWER_MANAGER_SSH_IDENTITY_FILE",
    "POWER_MANAGER_SSH_KNOWN_HOSTS_FILE",
  ])("空文字の %s を拒否する", (name) => {
    expect(() => loadRuntimeConfig({ ...validEnvironment(), [name]: "" })).toThrow(
      new RegExp(name),
    );
  });

  test("メッセージに値そのものを含めない", () => {
    const secret = "very-secret-value";
    expect(() =>
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_AUTH_PASSWORD_HASH: secret }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining(secret) }));
  });
});

describe("ポート", () => {
  test.each(["0", "65536", "abc", "8080.5", "-1", " 8080"])(
    "範囲外・不正なポート %s を拒否する",
    (value) => {
      expect(() =>
        loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_PORT: value }),
      ).toThrow(/POWER_MANAGER_PORT/);
    },
  );

  test.each([
    ["1", 1],
    ["65535", 65535],
    ["8080", 8080],
  ])("有効なポート %s を数値として読む", (value, expected) => {
    expect(loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_PORT: value }).port).toBe(
      expected,
    );
  });
});

describe("公開 Origin", () => {
  test.each([
    ["https://power.example.ts.net", "https://power.example.ts.net"],
    ["https://power.example.ts.net:8443", "https://power.example.ts.net:8443"],
    ["https://power.example.ts.net/", "https://power.example.ts.net"],
  ])("本番の HTTPS Origin %s を %s として受け付ける", (value, expected) => {
    expect(
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_PUBLIC_ORIGIN: value }).publicOrigin,
    ).toBe(expected);
  });

  test.each([
    ["http://localhost", "http://localhost"],
    ["http://localhost:5173", "http://localhost:5173"],
  ])("開発時の HTTP Origin %s を %s として受け付ける", (value, expected) => {
    expect(
      loadRuntimeConfig({
        ...validEnvironment(),
        NODE_ENV: "development",
        POWER_MANAGER_PUBLIC_ORIGIN: value,
      }).publicOrigin,
    ).toBe(expected);
  });

  test("本番では http://localhost の Origin を拒否する", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        NODE_ENV: "production",
        POWER_MANAGER_PUBLIC_ORIGIN: "http://localhost:5173",
      }),
    ).toThrow(/POWER_MANAGER_PUBLIC_ORIGIN/);
  });

  test("NODE_ENV 未設定（既定の production）でも HTTP Origin を拒否する", () => {
    expect(() =>
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_PUBLIC_ORIGIN: "http://localhost" }),
    ).toThrow(/POWER_MANAGER_PUBLIC_ORIGIN/);
  });

  test("スキームを含まない host を併せて導出する", () => {
    const runtime = loadRuntimeConfig({
      ...validEnvironment(),
      POWER_MANAGER_PUBLIC_ORIGIN: "https://power.example.ts.net:8443",
    });

    expect(runtime.publicOrigin).toBe("https://power.example.ts.net:8443");
    // allowedActionOrigins の照合形式に合わせる。スキームを含めると一致しない。
    expect(runtime.publicOriginHost).toBe("power.example.ts.net:8443");
  });

  test.each([
    // ワイルドカードは allowedActionOrigins で任意ホストに一致してしまう。
    "https://*.example.com",
    "https://*.ts.net",
    "https://*",
    "https://**",
    // 予約語ホストは `Origin: null` と完全一致する。
    "https://null",
    "https://undefined",
    "https://true",
    "https://false",
    // 空ラベル・末尾ドット・ポート 0 は Origin として無効。
    "https://a..b",
    "https://.example.com",
    "https://a.ts.net.",
    "https://power.example.ts.net:0",
  ])("Origin として不正な %s を拒否する", (value) => {
    expect(() =>
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_PUBLIC_ORIGIN: value }),
    ).toThrow(/POWER_MANAGER_PUBLIC_ORIGIN/);
  });

  test.each([
    "http://power.example.ts.net",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
    "https://power.example.ts.net/some/path",
    "https://user:pass@power.example.ts.net",
    "ftp://power.example.ts.net",
    "power.example.ts.net",
    "not a url",
  ])("HTTP の許可条件を満たさない %s を拒否する", (value) => {
    expect(() =>
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_PUBLIC_ORIGIN: value }),
    ).toThrow(/POWER_MANAGER_PUBLIC_ORIGIN/);
  });
});

describe("パスワードハッシュ", () => {
  test("Argon2id 以外のハッシュを拒否する", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        POWER_MANAGER_AUTH_PASSWORD_HASH: "$argon2i$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA",
      }),
    ).toThrow(/POWER_MANAGER_AUTH_PASSWORD_HASH/);
  });

  test.each(["plain-password", "$argon2id$", "$argon2id$v=19$m=65536,t=2,p=1$c2FsdA"])(
    "形式不正の %s を拒否する",
    (value) => {
      expect(() =>
        loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_AUTH_PASSWORD_HASH: value }),
      ).toThrow(/POWER_MANAGER_AUTH_PASSWORD_HASH/);
    },
  );
});

describe("絶対パス", () => {
  test.each([
    "POWER_MANAGER_CONFIG_PATH",
    "POWER_MANAGER_SSH_IDENTITY_FILE",
    "POWER_MANAGER_SSH_KNOWN_HOSTS_FILE",
  ])("相対パスの %s を拒否する", (name) => {
    expect(() => loadRuntimeConfig({ ...validEnvironment(), [name]: "relative/path" })).toThrow(
      new RegExp(name),
    );
  });
});
