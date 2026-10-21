import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `startRuntime` は終了直前の 1 行を `fs.writeSync(2, ...)` で書く（`console.error` だと
 * `process.exit` に追い越されるため）。`process.stderr.write` を spy しても捕まえられない
 * ので、`writeSync` 自体を差し替える。
 */
const writtenToStderr = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (fd: number, data: string) => {
      if (fd === 2) writtenToStderr.push(data);
      return data.length;
    },
  };
});

import { ConfigurationError, loadRuntimeConfig } from "../app/lib/config.server.ts";
import { configurationErrorExitCode } from "../app/lib/exit-codes.ts";
import { startRuntime } from "../server/startup.ts";

import { validEnvironment } from "./support/environment.ts";

/**
 * 起動要件は環境変数（と、後続の設定 JSON）の検証だけである（NFR-06）。
 * `ssh` 実行ファイルや鍵ファイルの存在は起動要件に含めない（`docs/architecture.md` 3.2）。
 */
function environmentWith(paths: { identityFile: string; knownHostsFile: string }) {
  return {
    ...validEnvironment(),
    POWER_MANAGER_SSH_IDENTITY_FILE: paths.identityFile,
    POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: paths.knownHostsFile,
  };
}

describe("起動要件", () => {
  test("ssh の鍵や known_hosts が存在しなくても起動検証を通す", () => {
    const runtime = loadRuntimeConfig(
      environmentWith({
        identityFile: "/nonexistent/power-manager/id_ed25519",
        knownHostsFile: "/nonexistent/power-manager/known_hosts",
      }),
    );

    // パスの形式だけを検証し、ファイルの実在や権限は見ない。
    expect(runtime.sshIdentityFile).toBe("/nonexistent/power-manager/id_ed25519");
    expect(runtime.sshKnownHostsFile).toBe("/nonexistent/power-manager/known_hosts");
  });

  test("PATH に ssh が無くても起動検証を通す", () => {
    const originalPath = process.env.PATH;
    // `= undefined` は文字列 "undefined" になるため `delete` で消す。
    delete process.env.PATH;
    try {
      const runtime = loadRuntimeConfig(
        environmentWith({
          identityFile: "/run/secrets/power-manager/id_ed25519",
          knownHostsFile: "/etc/power-manager/known_hosts",
        }),
      );

      // 起動要件に ssh の存在確認を含めない。不在は停止操作時に ssh_unavailable として扱う。
      expect(runtime.port).toBe(8080);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  test("PATH に ssh が無くても startRuntime が待受可能な設定を返す", () => {
    const originalPath = process.env.PATH;
    delete process.env.PATH;
    try {
      const exit = vi.fn();
      const runtime = startRuntime(validEnvironment(), exit);

      expect(exit).not.toHaveBeenCalled();
      expect(runtime.port).toBe(8080);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});

describe("startRuntime", () => {
  let stderr: string[];

  beforeEach(() => {
    writtenToStderr.length = 0;
    stderr = writtenToStderr;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("検証を通れば終了せずに設定を返す", () => {
    const exit = vi.fn();

    const runtime = startRuntime(validEnvironment(), exit);

    expect(exit).not.toHaveBeenCalled();
    expect(runtime.publicOrigin).toBe("https://power.example.ts.net");
    expect(stderr).toEqual([]);
  });

  test("設定不備では終了コード 78 で終了し、startup_failed を 1 行だけ出す", () => {
    const exit = vi.fn();

    expect(() => startRuntime({ ...validEnvironment(), POWER_MANAGER_PORT: "abc" }, exit)).toThrow(
      ConfigurationError,
    );

    expect(exit).toHaveBeenCalledWith(configurationErrorExitCode);
    expect(stderr).toHaveLength(1);
    const line = stderr[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      event: "startup_failed",
      code: "invalid_configuration",
    });
  });

  test("設定不備以外の例外は再送出し、終了しない", () => {
    const exit = vi.fn();

    // 環境変数が `undefined` のオブジェクトではなく `null` を渡すと、想定外の例外になる。
    expect(() => startRuntime(null as never, exit)).toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(stderr).toEqual([]);
  });

  test("startup_failed の reason に環境変数の値を混ぜない", () => {
    const exit = vi.fn();
    const secret = "super-secret-password-hash";

    try {
      startRuntime({ ...validEnvironment(), POWER_MANAGER_AUTH_PASSWORD_HASH: secret }, exit);
    } catch {
      // 終了コードはここでは見ない。
    }

    expect(stderr.join("")).not.toContain(secret);
    expect(stderr.join("")).toContain("POWER_MANAGER_AUTH_PASSWORD_HASH");
  });
});
