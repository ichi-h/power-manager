/**
 * 死活確認と /api/status の検証（FR-03, NFR-07, NFR-08）。
 *
 * TCP 接続の実体はモックに差し替え、3 状態の判定・タイムアウト扱い・同時実行数上限・
 * 進行中 Promise の共有を固定する。実接続を使う部分は `127.0.0.1` の待受ソケットで
 * online/offline を確認する。
 */
import { createServer } from "node:net";
import { beforeAll, describe, expect, test } from "vitest";

import {
  createStatusChecker,
  __testCheckOnce,
  __testCreateTcpCheck,
} from "../app/lib/power.server.ts";

/** 接続を拒否されるポート。環境ごとに使用中のポートが違うため開けてから閉じる。 */
let closedPort = 1;

/** テスト中に接続を受け付ける待受ポート。/api/status loader の検証で使う。 */
let echoPort = 1;

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("unexpected address");
  closedPort = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const echo = createServer();
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const echoAddress = echo.address();
  if (echoAddress === null || typeof echoAddress === "string") throw new Error("unexpected address");
  echoPort = echoAddress.port;
  // /api/status loader のテストが終わるまで開けておく。afterAll は describe の外では
  // 書けないため、モジュール末尾の後始末で閉じる。
  process.on("exit", () => echo.close());
});
import { loader as statusLoader } from "../app/routes/api.status.tsx";
import { createConfigStore, requireConfigStore } from "../app/lib/config-store.server.ts";
import { parseManagedConfig } from "../app/lib/runtime-config.server.ts";
import { RouterContextProvider } from "react-router";
import { configStoreContext } from "../app/lib/config-store.server.ts";

import { validManagedConfig } from "./support/managed-config.ts";

/** 同時実行数の上限（NFR-08）。実装の定数と同じ値を検証側にも置く。 */
const expectedConcurrency = 8;

describe("checkOnce の実 TCP 接続", () => {
  test("接続先が待受なら online、そうでなければ offline", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("unexpected address");
    try {
      expect(await __testCheckOnce("127.0.0.1", address.port)).toBe("online");
      // 接続済みの待受へさらに接続し、backlog に積まれても即確立することを固定する。
      expect(await __testCheckOnce("127.0.0.1", address.port)).toBe("online");
    } finally {
      server.close();
    }
  });

  test("接続の失敗は offline（FR-03）", async () => {
    // 接続拒否されるポートへの失敗。closedPort は beforeAll で閉じたポートである。
    const result = await __testCreateTcpCheck(1_000)("127.0.0.1", closedPort);
    expect(result).toBe("offline");
  });

  test("タイムアウトは offline として扱う（NFR-07）", async () => {
    // 実接続を開ける準備として、即座に accept も reject もしない待受ソケットを使い、
    // 短いタイムアウト値で打ち切られることを確認する。
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("unexpected address");
    try {
      // `connect` は backlog に積まれたまま確立しないため、タイムアウトで offline。
      // タイムアウト値を短くした確認単位で固定する。
      const start = Date.now();
      const result = await __testCreateTcpCheck(50)("192.0.2.1", address.port);
      expect(result).toBe("offline");
      expect(Date.now() - start).toBeLessThan(5_000);
    } finally {
      server.close();
    }
  });
});

describe("createStatusChecker", () => {
  test("3 状態の判定: online/offline を run の結果で返す", async () => {
    let result: "online" | "offline" = "online";
    const checker = createStatusChecker(async () => result);

    expect(await checker.check("nas", "h", 22)).toBe("online");
    result = "offline";
    // 進行中 Promise が残っていないため、2 回目は新しい確認になる。
    expect(await checker.check("nas", "h", 22)).toBe("offline");
  });

  test("同時実行数が 8 を超えない（NFR-08）", async () => {
    let running = 0;
    let peak = 0;
    const checker = createStatusChecker(async () => {
      running += 1;
      peak = Math.max(peak, running);
      // 全確認が並ぶのを待つ。並列数が上限を超えていれば peak が 9 以上になる。
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return "online";
    });

    const targets = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      ssh: { host: "h", port: 22 },
    }));
    await checker.checkAll(targets);

    expect(peak).toBeLessThanOrEqual(expectedConcurrency);
    expect(peak).toBe(expectedConcurrency);
  });

  test("進行中 Promise が共有される（NFR-08）", async () => {
    let calls = 0;
    const checker = createStatusChecker(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "online";
    });

    const [a, b, c] = await Promise.all([
      checker.check("nas", "h", 22),
      checker.check("nas", "h", 22),
      checker.check("nas", "h", 22),
    ]);
    expect([a, b, c]).toEqual(["online", "online", "online"]);
    expect(calls).toBe(1);

    // 完了後は破棄されるため、次の確認は新しく始まる。
    expect(await checker.check("nas", "h", 22)).toBe("online");
    expect(calls).toBe(2);
  });

  test("checkAll は全サーバーの状態を ID で返す", async () => {
    const checker = createStatusChecker(async (_host, port) => (port === 22 ? "online" : "offline"));

    const states = await checker.checkAll([
      { id: "nas", ssh: { host: "a", port: 22 } },
      { id: "builder", ssh: { host: "b", port: 2222 } },
    ]);

    expect(states.get("nas")).toBe("online");
    expect(states.get("builder")).toBe("offline");
  });

  test("reset は進行中 Promise を破棄する", async () => {
    let calls = 0;
    const checker = createStatusChecker(async () => {
      calls += 1;
      return "online";
    });

    const inFlight = checker.check("nas", "h", 22);
    checker.reset();
    await inFlight;

    const second = checker.check("nas", "h", 22);
    await second;
    expect(calls).toBe(2);
  });
});

describe("/api/status loader", () => {
  /** loader が要求する最小限の load context。 */
  function contextWithStore() {
    const store = createConfigStore(
      "/etc/power-manager/config.json",
      parseManagedConfig(validManagedConfig()),
    );
    const context = new RouterContextProvider();
    context.set(configStoreContext, store);
    return context;
  }

  // モジュールスコープの共有確認器はテストファイル内で完結するため、ここでは
  // loader を呼ぶごとに context を作り直すだけで済む。確認器の共有状態は
  // `createStatusChecker` のテスト側で検証済み。

  test("全サーバーの状態を application/json で返す", async () => {
    const context = contextWithStore();
    const base = requireConfigStore(context).current();
    // loader は共有の確認器を使うため、接続先を確実に待受可能なポートへ差し替える。
    // 設定は検証済みの値のみを扱うため、破壊はコピーを介して 1 か所だけ行う。
    const store = createConfigStore("/etc/power-manager/config.json", {
      ...base,
      servers: [
        { ...base.servers[0]!, ssh: { ...base.servers[0]!.ssh, host: "127.0.0.1", port: echoPort } },
      ],
    });
    context.set(configStoreContext, store);

    const response = await statusLoader({ context });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(await response.text())).toEqual({ states: { nas: "online" } });
  });

  test("確認失敗の対象は offline として返す", async () => {
    // 127.0.0.1:1 は ECONNREFUSED になるため offline。
    const base = parseManagedConfig(validManagedConfig());
    const config = {
      ...base,
      servers: [{ ...base.servers[0]!, ssh: { ...base.servers[0]!.ssh, port: 1 } }],
    };
    const store = createConfigStore("/etc/power-manager/config.json", config);
    const context = new RouterContextProvider();
    context.set(configStoreContext, store);

    const response = await statusLoader({ context });
    expect(JSON.parse(await response.text())).toEqual({ states: { nas: "offline" } });
  });
});
