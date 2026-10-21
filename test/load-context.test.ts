import { RouterContextProvider, createContext } from "react-router";
import { describe, expect, test, vi } from "vitest";

import {
  configContext,
  loadRuntimeConfig,
  requireRuntimeConfig,
} from "../app/lib/config.server.ts";
import { createLoadContext } from "../server/app.ts";

import { validEnvironment } from "./support/environment.ts";

describe("load context", () => {
  test("検証済みの実行時設定を loader/action から参照できる", () => {
    const runtime = loadRuntimeConfig(validEnvironment());
    const context = createLoadContext(runtime);

    // load context に載るのは公開値だけ（秘密値は同じ型に存在しない）。
    expect(context.get(configContext)).toEqual({
      configPath: "/etc/power-manager/config.json",
      port: 8080,
      publicOrigin: "https://power.example.ts.net",
      publicOriginHost: "power.example.ts.net",
      nodeEnv: "production",
    });
    expect(requireRuntimeConfig(context).configPath).toBe("/etc/power-manager/config.json");
    expect(requireRuntimeConfig(context).publicOrigin).toBe("https://power.example.ts.net");
    expect(requireRuntimeConfig(context).publicOriginHost).toBe("power.example.ts.net");
  });

  /**
   * `react-router build` の成果物はサーバーエントリとは別のモジュールグラフになる。
   * キーをモジュールスコープで作ると実体が 2 つになり、ルート側の `context.get` が失敗する。
   * ここでは別グラフを `globalThis` 経由の再評価で模し、同じキーが返ることを固定する。
   */
  test("configContext はモジュールを評価し直しても同じ実体になる", async () => {
    vi.resetModules();
    const reloaded = await import("../app/lib/config.server.ts");

    expect(reloaded.configContext).toBe(configContext);
  });

  test("秘密値は load context から到達できない", () => {
    const runtime = loadRuntimeConfig(validEnvironment());
    const context = createLoadContext(runtime);
    const publicConfig: Record<string, unknown> = { ...requireRuntimeConfig(context) };

    // `AuthConfig` / `SshConfig` のキーが紛れ込んでいないことを、値の一致ではなく
    // キーの集合で固定する（型で到達できないうえに、実行時にも載らない）。
    expect(Object.keys(publicConfig).sort()).toEqual([
      "configPath",
      "nodeEnv",
      "port",
      "publicOrigin",
      "publicOriginHost",
    ]);
    expect(JSON.stringify(publicConfig)).not.toContain(runtime.authPasswordHash);
    expect(JSON.stringify(publicConfig)).not.toContain(runtime.sshIdentityFile);
    expect(JSON.stringify(publicConfig)).not.toContain(runtime.authUsername);
  });

  test("設定を載せていない context からの参照は配線不整合と分かるエラーになる", () => {
    const empty = new RouterContextProvider();

    expect(() => requireRuntimeConfig(empty)).toThrow(/load context/);
    expect(() => requireRuntimeConfig(empty)).toThrow(/createLoadContext/);
  });

  test("別のキーで載せた値は読めない（キーの同一性で照合している）", () => {
    const runtime = loadRuntimeConfig(validEnvironment());
    const otherKey = createContext<typeof runtime>();
    const context = new RouterContextProvider();
    context.set(otherKey, runtime);

    expect(() => requireRuntimeConfig(context)).toThrow(/load context/);
  });
});
