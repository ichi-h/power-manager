import { describe, expect, test } from "vitest";

import { ConfigurationError, loadRuntimeConfig } from "../app/lib/config.server.ts";

import { validEnvironment } from "./support/environment.ts";

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
  test.each([
    "0",
    "65536",
    "abc",
    "8080.5",
    "-1",
    " 8080",
    "8080\n",
    "+8080",
    "1e3",
    // 先頭ゼロは 8 進数風の指定として黙って解釈しない。
    "08080",
    "00",
    "000",
    // 桁あふれは英語の内部メッセージを混ぜずに拒否する。
    "100000000000000000000",
    // 全角数字は数値として解釈しない。
    "８０８０",
  ])("範囲外・不正なポート %s を拒否する", (value) => {
    expect(() =>
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_PORT: value }),
    ).toThrow(/POWER_MANAGER_PORT/);
  });

  test("巨大な数値でも英語の内部メッセージを混ぜない", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        POWER_MANAGER_PORT: "100000000000000000000",
      }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("Too big") }));
  });

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

  test.each([
    "plain-password",
    "$argon2id$",
    "$argon2id$v=19$m=65536,t=2,p=1$CJ2eRzv21JkRoWJAsIi8Yg",
    "$argon2id$v=19$m=65536,t=2$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM",
    "$argon2id$m=65536,t=2,p=1$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM",
  ])("構造不正の %s を拒否する", (value) => {
    expect(() =>
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_AUTH_PASSWORD_HASH: value }),
    ).toThrow(/POWER_MANAGER_AUTH_PASSWORD_HASH/);
  });

  test("argon2.hash() の出力（m,p,t 順）を受け付ける", async () => {
    const argon2 = await import("argon2");
    const hash = await argon2.hash("password", { type: argon2.argon2id });

    // node-argon2 は `m,p,t` の順で出す。パラメータ順に依存しないことを固定する。
    expect(hash.startsWith("$argon2id$v=19$m=")).toBe(true);
    expect(
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_AUTH_PASSWORD_HASH: hash })
        .authPasswordHash,
    ).toBe(hash);
  });

  test.each([
    // 弱いパラメータは事実上総当たり可能になる。
    ["$argon2id$v=19$m=8,t=1,p=1$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM"],
    ["$argon2id$v=19$m=19455,t=2,p=1$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM"],
    ["$argon2id$v=19$m=65536,t=1,p=1$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM"],
    ["$argon2id$v=19$m=65536,t=2,p=5$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM"],
    // 過大なパラメータは未認証リクエストごとの検証でメモリを枯渇させる。
    ["$argon2id$v=19$m=1048576,t=2,p=1$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM"],
    ["$argon2id$v=19$m=262145,t=2,p=1$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM"],
    ["$argon2id$v=19$m=65536,t=11,p=1$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM"],
    // 短いソルト・短いハッシュは argon2.verify が例外を投げる。
    ["$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM"],
    ["$argon2id$v=19$m=65536,t=2,p=1$CJ2eRzv21JkRoWJAsIi8Yg$aGFzaA"],
  ])("パラメータ範囲外の %s を拒否する", (value) => {
    expect(() =>
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_AUTH_PASSWORD_HASH: value }),
    ).toThrow(/POWER_MANAGER_AUTH_PASSWORD_HASH/);
  });

  test.each([
    "POWER_MANAGER_AUTH_PASSWORD_HASH",
    "POWER_MANAGER_SSH_IDENTITY_FILE",
    "POWER_MANAGER_CONFIG_PATH",
  ])("メッセージに %s の値を含めない", (name) => {
    const secret = "very-secret-value";
    expect(() => loadRuntimeConfig({ ...validEnvironment(), [name]: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
  });
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

  test.each([
    "/etc/power-manager/../power-manager/config.json",
    "/etc//power-manager/config.json",
    "/etc/power-manager/",
    "/etc/power-manager/config.json ",
    "/etc/power-manager/\0config.json",
  ])("正規化されていないパス %j を拒否する", (value) => {
    expect(() =>
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_CONFIG_PATH: value }),
    ).toThrow(/POWER_MANAGER_CONFIG_PATH/);
  });

  test("NUL バイトを含むパスの拒否メッセージに値を含めない", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        POWER_MANAGER_CONFIG_PATH: "/etc/\0secret.json",
      }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("secret") }));
  });
});

describe("ユーザー名", () => {
  test.each([
    "admin:password",
    "admin user",
    "admin\tuser",
    "管理者",
    "a".repeat(65),
  ])("Basic 認証で扱えない %j を拒否する", (value) => {
    expect(() =>
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_AUTH_USERNAME: value }),
    ).toThrow(/POWER_MANAGER_AUTH_USERNAME/);
  });

  test.each(["a", "admin", "admin.user-name_1", "a".repeat(64)])(
    "有効なユーザー名 %j を受け付ける",
    (value) => {
      expect(
        loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_AUTH_USERNAME: value })
          .authUsername,
      ).toBe(value);
    },
  );
});

describe("空白", () => {
  test.each(["  ", " admin", "admin "])("前後空白を含むユーザー名 %j を拒否する", (value) => {
    expect(() =>
      loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_AUTH_USERNAME: value }),
    ).toThrow(/POWER_MANAGER_AUTH_USERNAME/);
  });
});

describe("未知の環境変数", () => {
  test("検証対象外の変数を無視する", () => {
    const runtime = loadRuntimeConfig({
      ...validEnvironment(),
      AWS_SECRET_ACCESS_KEY: "leaked-secret",
    });

    expect(runtime.port).toBe(8080);
  });

  test("検証対象外の変数の値をエラーメッセージに含めない", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment(),
        POWER_MANAGER_PORT: "not-a-port",
        AWS_SECRET_ACCESS_KEY: "leaked-secret",
      }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("leaked-secret") }));
  });
});
