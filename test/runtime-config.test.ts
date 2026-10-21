import { describe, expect, test } from "vitest";

import { ManagedConfigError, parseManagedConfig } from "../app/lib/runtime-config.server.ts";

import { validManagedConfig } from "./support/managed-config.ts";

/**
 * 検証を通る定義。個々のテストはここから 1 か所だけ壊す。
 * 雛形は `test/support/managed-config.ts` の 1 つだけを使う。
 */
function validConfig(): Record<string, unknown> {
  return validManagedConfig();
}

/**
 * 検証エラーの指摘を 1 本の文字列にして `toContain` で見る。
 * 利用者に見える `ManagedConfigError.issues` をそのまま使う（別実装を挟まない）。
 */
function issuesOf(input: unknown): string {
  try {
    parseManagedConfig(input);
  } catch (error) {
    if (error instanceof ManagedConfigError) return error.issues.join(" / ");
    throw error;
  }
  throw new Error("検証を通ってしまいました");
}

describe("設定 JSON のスキーマ", () => {
  test("既定値を適用する（groups、wol.broadcastAddress、wol.port、ssh.port）", () => {
    const input = validConfig();
    // `wol` を省略した定義でも既定値が入る。
    delete (input.servers as Record<string, unknown>[])[0]!.wol;

    const config = parseManagedConfig(input);
    const server = config.servers[0];

    expect(server?.groups).toEqual(["storage"]);
    expect(server?.wol).toEqual({ broadcastAddress: "255.255.255.255", port: 9 });
    expect(server?.ssh.port).toBe(22);
  });

  test("3 つの集合が空でも受理する（servers の空は仕様）", () => {
    // `servers` を空にできるのは全サーバー削除が利用者の判断だからである（仕様）。
    // `.min(1)` を後から足しても気付けるよう、空配列の受理をここで固定する。
    const config = parseManagedConfig({
      version: 2,
      servers: [],
      groups: [],
      schedules: [],
    });

    expect(config.servers).toEqual([]);
    expect(config.groups).toEqual([]);
    expect(config.schedules).toEqual([]);
  });

  test("wol を空オブジェクトで指定しても既定値になる", () => {
    const input = validConfig();
    (input.servers as Record<string, unknown>[])[0]!.wol = {};

    expect(parseManagedConfig(input).servers[0]?.wol).toEqual({
      broadcastAddress: "255.255.255.255",
      port: 9,
    });
  });

  test("明示した値は既定値で上書きしない", () => {
    const input = validConfig();
    const server = (input.servers as Record<string, unknown>[])[0]!;
    server.wol = { broadcastAddress: "192.168.1.255", port: 7 };
    server.ssh = { ...(server.ssh as object), port: 2222 };

    expect(parseManagedConfig(input).servers[0]?.wol).toEqual({
      broadcastAddress: "192.168.1.255",
      port: 7,
    });
    expect(parseManagedConfig(input).servers[0]?.ssh.port).toBe(2222);
  });

  test("ルートの未知項目を拒否する", () => {
    expect(issuesOf({ ...validConfig(), extra: true })).toContain("未知の項目です");
  });

  test("オブジェクト位置の型違いを「未知の項目です」と言わない", () => {
    // 未知キーと型違いでは直し方が違う。同じ文言にすると原因を推測できない（FR-09）。
    const input = validConfig();
    (input.servers as Record<string, unknown>[])[0]!.wol = null;

    const issues = issuesOf(input);
    expect(issues).toContain("servers.0.wol: オブジェクトで指定してください");
    expect(issues).not.toContain("未知の項目です");
  });

  test("ルートがオブジェクトでなければ型違いとして拒否する", () => {
    expect(issuesOf([])).toContain("オブジェクトで指定してください");
  });

  test("入れ子の未知項目も拒否する", () => {
    const input = validConfig();
    (input.servers as Record<string, unknown>[])[0]!.mac = "00:11:22:33:44:55";

    expect(issuesOf(input)).toContain("servers.0: 未知の項目です");
  });

  test("version は 2 固定で、1 は拒否する", () => {
    expect(issuesOf({ ...validConfig(), version: 1 })).toContain("version:");
    expect(issuesOf({ ...validConfig(), version: "2" })).toContain("version:");
    expect(() => parseManagedConfig({ ...validConfig(), version: undefined })).toThrow(
      ManagedConfigError,
    );
  });

  test("version の欠落は「必須」、不一致は指定値を案内する", () => {
    // 欠落と不一致では直し方が違う（書く / 書き換える）。
    const missing = validConfig();
    delete missing.version;
    expect(issuesOf(missing)).toContain("version: 必須です");
    expect(issuesOf({ ...validConfig(), version: 1 })).toContain("version: 2 を指定してください");
  });

  test("型不一致を項目名付きで拒否する", () => {
    const input = validConfig();
    (input.servers as Record<string, unknown>[])[0]!.macAddress = 1234;

    expect(issuesOf(input)).toContain("servers.0.macAddress: 文字列で指定してください");
  });

  test("必須項目の欠落と空値を拒否する", () => {
    const input = validConfig();
    const server = (input.servers as Record<string, unknown>[])[0]!;
    delete server.name;
    server.macAddress = "";

    const issues = issuesOf(input);
    expect(issues).toContain("servers.0.name: 必須です");
    expect(issues).toContain("servers.0.macAddress: 空にできません");
  });

  test("前後の空白を含む値を拒否する", () => {
    const input = validConfig();
    (input.servers as Record<string, unknown>[])[0]!.id = " nas";

    expect(issuesOf(input)).toContain("servers.0.id: 前後に空白を含めないでください");
  });

  test("MAC アドレスの形式を検証する", () => {
    for (const macAddress of ["00-11-22-33-44-55", "00:11:22:33:44", "00:11:22:33:44:55:66", "gg:11:22:33:44:55"]) {
      const input = validConfig();
      (input.servers as Record<string, unknown>[])[0]!.macAddress = macAddress;

      expect(issuesOf(input)).toContain("servers.0.macAddress: MAC アドレスの形式");
    }
  });

  test("ブロードキャストアドレスは IPv4 のみを受け付ける", () => {
    const input = validConfig();
    (input.servers as Record<string, unknown>[])[0]!.wol = { broadcastAddress: "ff02::1" };

    expect(issuesOf(input)).toContain("servers.0.wol.broadcastAddress: IPv4 アドレス");
  });

  test("ポート番号は 1 から 65535 の整数だけを受け付ける", () => {
    // 境界値そのものは受理し、外側だけを拒否する。
    for (const port of [1, 65535]) {
      const input = validConfig();
      (input.servers as Record<string, unknown>[])[0]!.wol = { port };

      expect(parseManagedConfig(input).servers[0]?.wol.port).toBe(port);
    }

    for (const port of [0, 65536]) {
      const input = validConfig();
      (input.servers as Record<string, unknown>[])[0]!.wol = { port };

      expect(issuesOf(input)).toContain("servers.0.wol.port: 1 から 65535 の整数で指定してください");
    }

    // 小数は範囲ではなく整数性の指摘になる（直し方が違う）。
    const decimal = validConfig();
    (decimal.servers as Record<string, unknown>[])[0]!.wol = { port: 9.5 };
    expect(issuesOf(decimal)).toContain("servers.0.wol.port: 整数で指定してください");
  });

  test("ポート番号は文字列を受け付けない", () => {
    const input = validConfig();
    (input.servers as Record<string, unknown>[])[0]!.wol = { port: "9" };

    expect(issuesOf(input)).toContain("servers.0.wol.port: 数値で指定してください");
  });

  test("ルート直下の必須項目の欠落を拒否する", () => {
    const onlyVersion = validConfig();
    delete onlyVersion.servers;
    delete onlyVersion.groups;
    delete onlyVersion.schedules;
    expect(issuesOf(onlyVersion)).toContain("servers: 必須です");
    expect(issuesOf(onlyVersion)).toContain("groups: 必須です");
    expect(issuesOf(onlyVersion)).toContain("schedules: 必須です");

    expect(issuesOf({ ...validConfig(), servers: {} })).toContain(
      "servers: 配列で指定してください",
    );
    expect(issuesOf({ ...validConfig(), servers: null })).toContain(
      "servers: 配列で指定してください",
    );
  });
});
