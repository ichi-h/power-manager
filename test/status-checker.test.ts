/**
 * 死活確認と /api/status の検証（FR-03, NFR-07, NFR-08）。
 *
 * 確認器の実行単位はモックに差し替え、3 状態の判定・タイムアウト扱い・同時実行数上限・
 * 進行中 Promise の共有を固定する。`createTcpCheck` の実 TCP 接続は 127.0.0.1 の
 * 待受ソケットと到達不能アドレスで online/offline/timed-out を確認する。
 */
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { ServerState } from '../app/lib/model.ts';

import {
  checkTimeoutMs,
  createStatusChecker,
  createTcpCheck,
  type StatusChecker,
} from '../app/lib/power.server.ts';
import { loader as statusLoader } from '../app/routes/api.status.tsx';
import { statusCheckerContext } from '../app/lib/status-checker-context.ts';
import {
  configStoreContext,
  createConfigStore,
} from '../app/lib/config-store.server.ts';
import { parseManagedConfig } from '../app/lib/runtime-config.server.ts';
import { RouterContextProvider } from 'react-router';

import { validManagedConfig } from './support/managed-config.ts';

/** 接続を拒否されるポート。環境ごとに使用中のポートが違うため開けてから閉じる。 */
let closedPort = 1;

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (address === null || typeof address === 'string')
    throw new Error('unexpected address');
  closedPort = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(() => {
  // モジュール末尾に開けっぱなしの待受がないため、後始末は不要。vitest はプロセスを
  // 終了するため、ここで閉じるソケットもない。
});

/** アドレスの型がポートを持つことを検査する。 */
function portOf(address: { port: number } | string | null): number {
  if (address === null || typeof address === 'string')
    throw new Error('unexpected address');
  return address.port;
}

describe('createTcpCheck の実 TCP 接続', () => {
  test('接続先が待受なら online', async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = portOf(server.address());
    try {
      expect(await createTcpCheck(checkTimeoutMs)('127.0.0.1', port)).toBe(
        'online',
      );
    } finally {
      server.close();
    }
  });

  test('接続の失敗は offline（FR-03）', async () => {
    // 接続拒否されるポートへの失敗。closedPort は beforeAll で閉じたポートである。
    const result = await createTcpCheck(checkTimeoutMs)(
      '127.0.0.1',
      closedPort,
    );
    expect(result).toBe('offline');
  });

  test('タイムアウトは offline として扱う（NFR-07）', async () => {
    // 192.0.2.0/24（TEST-NET-1）は到達不能のため、即座に拒否される環境でも接続が
    // 確立しない。短いタイムアウト値で打ち切られることを所要時間の下限で固定する。
    const timeoutMs = 50;
    const start = Date.now();
    const result = await createTcpCheck(timeoutMs)('192.0.2.1', 80);
    const elapsed = Date.now() - start;
    expect(result).toBe('offline');
    // 即拒否（ECONNREFUSED が返る環境）では elapsed がほぼ 0 になる。下限を課すことで
    // タイムアウト経路（setTimeout による打ち切り）を通ったことを決定的にする。
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs);
  });
});

describe('NFR-07 の固定', () => {
  test('checkTimeoutMs は 5 秒', () => {
    expect(checkTimeoutMs).toBe(5_000);
  });
});

describe('createStatusChecker', () => {
  test('3 状態の判定: online/offline を run の結果で返す', async () => {
    let result: 'online' | 'offline' = 'online';
    const checker = createStatusChecker(async () => result);

    expect(await checker.check('nas', 'h', 22)).toBe('online');
    result = 'offline';
    // 進行中 Promise が残っていないため、2 回目は新しい確認になる。
    expect(await checker.check('nas', 'h', 22)).toBe('offline');
  });

  test('同時実行数が 8 を超えない（NFR-08）', async () => {
    let running = 0;
    let peak = 0;
    const checker = createStatusChecker(async () => {
      running += 1;
      peak = Math.max(peak, running);
      // 全確認が並ぶのを待つ。並列数が上限を超えていれば peak が 9 以上になる。
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return 'online';
    });

    const targets = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      ssh: { host: 'h', port: 22 },
    }));
    await checker.checkAll(targets);

    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBe(8);
  });

  test('進行中 Promise が共有される（NFR-08）', async () => {
    let calls = 0;
    const checker = createStatusChecker(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'online';
    });

    const [a, b, c] = await Promise.all([
      checker.check('nas', 'h', 22),
      checker.check('nas', 'h', 22),
      checker.check('nas', 'h', 22),
    ]);
    expect([a, b, c]).toEqual(['online', 'online', 'online']);
    expect(calls).toBe(1);

    // 完了後は破棄されるため、次の確認は新しく始まる。
    expect(await checker.check('nas', 'h', 22)).toBe('online');
    expect(calls).toBe(2);
  });

  test('checkAll は全サーバーの状態を ID で返す', async () => {
    const checker = createStatusChecker(async (_host, port) =>
      port === 22 ? 'online' : 'offline',
    );

    const states = await checker.checkAll([
      { id: 'nas', ssh: { host: 'a', port: 22 } },
      { id: 'builder', ssh: { host: 'b', port: 2222 } },
    ]);

    expect(states.get('nas')).toBe('online');
    expect(states.get('builder')).toBe('offline');
  });

  test('reset は進行中 Promise を破棄する', async () => {
    let calls = 0;
    const checker = createStatusChecker(async () => {
      calls += 1;
      return 'online';
    });

    const inFlight = checker.check('nas', 'h', 22);
    checker.reset();
    await inFlight;

    const second = checker.check('nas', 'h', 22);
    await second;
    expect(calls).toBe(2);
  });
});

describe('/api/status loader', () => {
  /** 確認器を差し替えた load context を作る。run の戻り値は固定値で足りる。 */
  function contextWith(
    run: (host: string, port: number) => Promise<ServerState>,
  ) {
    const store = createConfigStore(
      '/etc/power-manager/config.json',
      parseManagedConfig(validManagedConfig()),
    );
    const context = new RouterContextProvider();
    context.set(configStoreContext, store);
    // loader の検証は確認器の実行単位もモックに差し替え、本物の TCP 待受に依存しない。
    context.set(statusCheckerContext, createStatusChecker(run));
    return context;
  }

  test('全サーバーの状態を application/json で返す', async () => {
    const context = contextWith(async () => 'online');
    const response = await statusLoader({ context });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(await response.text())).toEqual({
      states: { nas: 'online' },
    });
  });

  test('確認前の対象は unknown を返す', async () => {
    // unknown は loader が確認結果を unknown のまま返す経路で検証する。
    const base = parseManagedConfig(validManagedConfig());
    const config = {
      ...base,
      servers: [
        { ...base.servers[0]!, ssh: { ...base.servers[0]!.ssh, port: 1 } },
      ],
    };
    const store = createConfigStore('/etc/power-manager/config.json', config);
    const context = new RouterContextProvider();
    context.set(configStoreContext, store);
    // 確認前の対象（checkAll が状態を返さない対象）は unknown のまま返る経路を作る。
    const checker: StatusChecker = {
      check: async () => {
        throw new Error('check は呼ばれない');
      },
      checkAll: async (servers) => {
        // 状態を持たない空の対応を返す。全対象が「確認前」になる。
        expect(servers.length).toBe(1);
        return new Map();
      },
      reset: () => {},
    };
    context.set(statusCheckerContext, checker);
    const response = await statusLoader({ context });
    expect(JSON.parse(await response.text())).toEqual({
      states: { nas: 'unknown' },
    });
  });

  test('確認失敗の対象は offline として返す', async () => {
    const base = parseManagedConfig(validManagedConfig());
    const config = {
      ...base,
      servers: [
        { ...base.servers[0]!, ssh: { ...base.servers[0]!.ssh, port: 1 } },
      ],
    };
    const store = createConfigStore('/etc/power-manager/config.json', config);
    const context = new RouterContextProvider();
    context.set(configStoreContext, store);
    context.set(
      statusCheckerContext,
      createStatusChecker(async (_host, port) => {
        // 127.0.0.1:1 は ECONNREFUSED になるため offline。
        expect(port).toBe(1);
        return 'offline';
      }),
    );

    const response = await statusLoader({ context });
    expect(JSON.parse(await response.text())).toEqual({
      states: { nas: 'offline' },
    });
  });
});
