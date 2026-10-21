import { describe, expect, test } from "vitest";

import { loadRuntimeConfig } from "../server/app.ts";

describe("実行時設定", () => {
  test("ポートを数値として読む", () => {
    expect(loadRuntimeConfig({ POWER_MANAGER_PORT: "8080" }).port).toBe(8080);
  });

  test("ポートが欠落していれば拒否する", () => {
    expect(() => loadRuntimeConfig({})).toThrow(/POWER_MANAGER_PORT/);
  });

  test.each(["0", "65536", "abc", "8080.5"])("範囲外・不正なポート %s を拒否する", (value) => {
    expect(() => loadRuntimeConfig({ POWER_MANAGER_PORT: value })).toThrow();
  });
});
