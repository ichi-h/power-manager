import { describe, expect, test } from "vitest";

import { loadRuntimeConfig } from "../app/lib/config.server.ts";

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
    process.env.PATH = "/nonexistent/bin";
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
      process.env.PATH = originalPath;
    }
  });
});
