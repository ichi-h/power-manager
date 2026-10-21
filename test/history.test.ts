/**
 * 実行結果リングバッファの検証（FR-13, NFR-02）。
 *
 * - 上限 100 件を超えたら最古の要素から破棄される。
 * - `recent` は新しい順で返し、保持外の要素は返さない。
 * - 呼び出し側へ渡した配列を後から書き換えても内部の保持へ影響しない。
 */
import { describe, expect, test } from "vitest";

import {
  createOperationHistory,
  historyCapacity,
  requireHistory,
} from "../app/lib/history.server.ts";
import type { PowerOperationRecord } from "../app/lib/power.server.ts";
import { RouterContextProvider } from "react-router";
import { historyContext } from "../app/lib/history.server.ts";

/** テスト用の要素 1 件。順序を見分けるため `target.id` に連番を使う。 */
function record(id: string): PowerOperationRecord {
  return {
    at: "2026-01-02T03:04:05.678Z",
    target: { type: "server", id },
    operation: "wake",
    result: "succeeded",
    code: null,
  };
}

describe("createOperationHistory", () => {
  test("既定は 100 件まで保持する", () => {
    const history = createOperationHistory();
    expect(historyCapacity).toBe(100);

    for (let index = 0; index < 150; index += 1) {
      history.push(record(`server-${index}`));
    }

    const recent = history.recent();
    expect(recent).toHaveLength(100);
    // 最古（0〜49）は破棄され、最新が先頭に来る。
    expect(recent[0]).toEqual(record("server-149"));
    expect(recent[99]).toEqual(record("server-50"));
  });

  test("上限超過時は最古から破棄する", () => {
    const history = createOperationHistory(3);
    history.push(record("a"));
    history.push(record("b"));
    history.push(record("c"));
    history.push(record("d"));

    expect(history.recent().map((r) => r.target.id)).toEqual(["d", "c", "b"]);
  });

  test("保持枠より少ないうちは破棄しない", () => {
    const history = createOperationHistory(3);
    history.push(record("a"));
    history.push(record("b"));

    expect(history.recent().map((r) => r.target.id)).toEqual(["b", "a"]);
  });

  test("空のときは空配列を返す", () => {
    expect(createOperationHistory().recent()).toEqual([]);
  });

  test("予約実行の要素は scheduleId を保持する", () => {
    const history = createOperationHistory();
    history.push({
      at: "2026-01-02T03:04:05.678Z",
      scheduleId: "nightly",
      target: { type: "group", id: "storage" },
      operation: "shutdown",
      result: "failed",
      code: "ssh_unavailable",
    });

    expect(history.recent()[0]?.scheduleId).toBe("nightly");
    expect(history.recent()[0]?.code).toBe("ssh_unavailable");
  });

  test("recent が返す配列の書き換えは保持へ影響しない", () => {
    const history = createOperationHistory();
    history.push(record("a"));
    history.push(record("b"));

    const recent = history.recent() as Array<PowerOperationRecord>;
    recent.pop();
    recent.push(record("injected"));

    expect(history.recent().map((r) => r.target.id)).toEqual(["b", "a"]);
  });

  test("capacity が 0 のときは何も保持しない", () => {
    const history = createOperationHistory(0);
    history.push(record("a"));
    expect(history.recent()).toEqual([]);
  });
});

describe("load context", () => {
  test("リングバッファを載せた context から読み出せる", () => {
    const provider = new RouterContextProvider();
    const history = createOperationHistory();
    provider.set(historyContext, history);

    expect(requireHistory(provider)).toBe(history);
  });

  test("載せていない context からの読み出しは配線不整合と分かるエラーになる", () => {
    expect(() => requireHistory(new RouterContextProvider())).toThrow(
      /load context/,
    );
  });

  test("historyContext はモジュールを評価し直しても同じ実体になる", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    const reloaded = await import("../app/lib/history.server.ts");
    expect(reloaded.historyContext).toBe(historyContext);
  });
});