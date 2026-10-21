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

/**
 * 設定 JSON の読込みだけを差し替える。
 *
 * 起動検証はファイルの実在に依存させたくない（鍵ファイルの存在は起動要件に含めない
 * のと同じ理由）。`node:fs/promises` の `readFile` はここで置き換える。
 */
const configFile = vi.hoisted(() => ({
  content: "" as string,
  error: null as Error | null,
  /** `readFile` に渡されたパス。起動経路が設定のパスを読んでいることを確かめる。 */
  paths: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: string) => {
      configFile.paths.push(path);
      if (configFile.error) throw configFile.error;
      return configFile.content;
    },
  };
});

import { ConfigurationError, loadRuntimeConfig } from "../app/lib/config.server.ts";
import { configurationErrorExitCode } from "../app/lib/exit-codes.ts";
import { ManagedConfigError } from "../app/lib/runtime-config.server.ts";
import { exitAfterStartupFailure, startRuntime } from "../server/startup.ts";

import { validEnvironment } from "./support/environment.ts";
import { validManagedConfig } from "./support/managed-config.ts";

/**
 * 起動要件は環境変数と管理対象 JSON の検証だけである（NFR-06）。
 * `ssh` 実行ファイルや鍵ファイルの実在は起動要件に含めない（`docs/architecture.md` 3.2）。
 */
function environmentWith(paths: { identityFile: string; knownHostsFile: string }) {
  return {
    ...validEnvironment(),
    POWER_MANAGER_SSH_IDENTITY_FILE: paths.identityFile,
    POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: paths.knownHostsFile,
  };
}

beforeEach(() => {
  writtenToStderr.length = 0;
  configFile.content = JSON.stringify(validManagedConfig());
  configFile.error = null;
  configFile.paths.length = 0;
});

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

  test("PATH に ssh が無くても startRuntime が待受可能な設定を返す", async () => {
    const originalPath = process.env.PATH;
    delete process.env.PATH;
    try {
      const exit = vi.fn();
      const startup = await startRuntime(validEnvironment(), exit);

      expect(exit).not.toHaveBeenCalled();
      expect(startup.runtime.port).toBe(8080);
      expect(startup.configStore.current().servers[0]?.id).toBe("nas");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});

describe("startRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("検証を通れば終了せずに設定と設定ストアを返す", async () => {
    const exit = vi.fn();

    const startup = await startRuntime(validEnvironment(), exit);

    expect(exit).not.toHaveBeenCalled();
    expect(startup.runtime.publicOrigin).toBe("https://power.example.ts.net");
    // 環境変数で検証したパスをそのまま読む（既定パスを読み直さない）。
    expect(configFile.paths).toEqual([validEnvironment().POWER_MANAGER_CONFIG_PATH]);
    expect(startup.configStore.current().version).toBe(2);
    expect(writtenToStderr).toEqual([]);
  });

  test("環境変数の不備では終了コード 78 で終了し、startup_failed を 1 行だけ出す", async () => {
    const exit = vi.fn();

    await expect(
      startRuntime({ ...validEnvironment(), POWER_MANAGER_PORT: "abc" }, exit),
    ).rejects.toThrow(ConfigurationError);

    expect(exit).toHaveBeenCalledWith(configurationErrorExitCode);
    expect(writtenToStderr).toHaveLength(1);
    const line = writtenToStderr[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      event: "startup_failed",
      code: "invalid_configuration",
    });
  });

  test("設定 JSON の検証失敗も終了コード 78 で終了する（FR-08）", async () => {
    const exit = vi.fn();
    configFile.content = JSON.stringify({ ...validManagedConfig(), version: 1 });

    await expect(startRuntime(validEnvironment(), exit)).rejects.toThrow(ManagedConfigError);

    expect(exit).toHaveBeenCalledWith(configurationErrorExitCode);
    expect(JSON.parse(writtenToStderr[0] ?? "")).toMatchObject({
      event: "startup_failed",
      code: "invalid_configuration",
    });
    // 検証の対象が環境変数ではなく管理対象 JSON だと分かる文言にする。
    expect(writtenToStderr.join("")).toContain("管理対象の設定が不正です");
  });

  test("設定ファイルが読めない場合も設定不備として終了する", async () => {
    const exit = vi.fn();
    configFile.error = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });

    await expect(startRuntime(validEnvironment(), exit)).rejects.toThrow(ManagedConfigError);

    expect(exit).toHaveBeenCalledWith(configurationErrorExitCode);
    expect(writtenToStderr.join("")).toContain("設定ファイルが見つかりません");
    // 生の fs メッセージ（パス）はログに出さない。
    expect(writtenToStderr.join("")).not.toContain("no such file or directory");
  });

  test("設定不備以外の例外は再送出し、終了しない", async () => {
    const exit = vi.fn();

    // 環境変数が `undefined` のオブジェクトではなく `null` を渡すと、想定外の例外になる。
    await expect(startRuntime(null as never, exit)).rejects.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(writtenToStderr).toEqual([]);
  });

  test("起動経路の出口は設定不備だけを終了コード 78 にする", async () => {
    // `server/index.ts` の catch が通る関数そのものを固定する。例外の種別ごとに
    // 「再起動抑止 / 再起動して記録」が分かれる（NFR-05, NFR-10）。
    const configurationExit = vi.fn();
    expect(() =>
      exitAfterStartupFailure(
        new ConfigurationError("POWER_MANAGER_PORT: 数値で指定してください"),
        configurationExit,
      ),
    ).toThrow(ConfigurationError);
    expect(configurationExit).toHaveBeenCalledExactlyOnceWith(configurationErrorExitCode);
    // 設定不備の 1 行は `startRuntime` が出力済み。二重に出さない。
    expect(writtenToStderr).toEqual([]);

    const runtimeError = new TypeError("managedConfig is not iterable");
    expect(() => exitAfterStartupFailure(runtimeError, vi.fn())).toThrow(runtimeError);
    expect(writtenToStderr).toHaveLength(1);
    expect(JSON.parse(writtenToStderr[0] ?? "")).toEqual({
      event: "startup_failed",
      code: "operation_failed",
      reason: "TypeError",
    });
  });

  test("startup_failed の reason に環境変数の値を混ぜない", async () => {
    const exit = vi.fn();
    const secret = "super-secret-password-hash";

    await expect(
      startRuntime({ ...validEnvironment(), POWER_MANAGER_AUTH_PASSWORD_HASH: secret }, exit),
    ).rejects.toThrow();
    expect(writtenToStderr.join("")).not.toContain(secret);
    expect(writtenToStderr.join("")).toContain("POWER_MANAGER_AUTH_PASSWORD_HASH");
  });
});
