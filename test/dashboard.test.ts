/**
 * 一覧画面の loader / action の検証（FR-01, FR-04, FR-05, FR-07, FR-13）。
 *
 * 画面の描画（行内の進行表示・自動更新・確認ダイアログ）は `test/routes.test.tsx` が
 * クライアント側で検証する。ここではサーバー側の入出力だけを見る。
 */
import { RouterContextProvider } from 'react-router';
import { describe, expect, test, vi } from 'vitest';

import {
  configStoreContext,
  createConfigStore,
} from '../app/lib/config-store.server.ts';
import {
  historyContext,
  createOperationHistory,
} from '../app/lib/history.server.ts';
import { operatorContext } from '../app/lib/operator-context.server.ts';
import { parseManagedConfig } from '../app/lib/runtime-config.server.ts';
import type {
  PowerOperationRecord,
  StatusChecker,
} from '../app/lib/power.server.ts';
import { sshRuntimeContext } from '../app/lib/ssh-runtime-context.server.ts';
import { statusCheckerContext } from '../app/lib/status-checker-context.ts';
import {
  action,
  loader,
  toReasonLabel,
  toResultKind,
} from '../app/routes/dashboard.tsx';

import { validManagedConfig } from './support/managed-config.ts';

/** 2 台・2 グループの定義。行の順序と所属グループの表示を確かめるために使う。 */
function twoServerConfig() {
  const config = validManagedConfig();
  config.servers = [
    {
      id: 'nas',
      name: 'NAS',
      groups: ['storage'],
      macAddress: '00:11:22:33:44:55',
      wol: { broadcastAddress: '192.168.1.255', port: 9 },
      ssh: {
        host: 'nas.example.internal',
        port: 22,
        user: 'power-manager',
        shutdownCommand: 'sudo systemctl poweroff',
      },
    },
    {
      id: 'test-01',
      name: '検証機 01',
      groups: ['storage', 'test'],
      macAddress: '00:11:22:33:44:66',
      wol: { broadcastAddress: '192.168.1.255', port: 9 },
      ssh: {
        host: 'test-01.example.internal',
        port: 22,
        user: 'power-manager',
        shutdownCommand: 'sudo systemctl poweroff',
      },
    },
  ];
  config.groups = [
    { id: 'storage', name: 'ストレージ' },
    { id: 'test', name: '検証機' },
  ];
  return config;
}

/** loader の loader 引数に渡す load context。 */
function loaderContext(options: {
  config?: Record<string, unknown>;
  states?: ReadonlyMap<string, 'online' | 'offline' | 'unknown'>;
  recent?: ReadonlyArray<PowerOperationRecord>;
}) {
  const managed = parseManagedConfig(options.config ?? twoServerConfig());
  const store = createConfigStore('/etc/power-manager/config.json', managed);
  const history = createOperationHistory();
  for (const record of [...(options.recent ?? [])].reverse())
    history.push(record);

  const states =
    options.states ??
    new Map(
      managed.servers.map((server) => [server.id, 'unknown' as const] as const),
    );
  const checker: StatusChecker = {
    check: async () => 'unknown',
    checkAll: async () => states,
    reset: () => {},
  };

  const context = new RouterContextProvider();
  context.set(configStoreContext, store);
  context.set(historyContext, history);
  context.set(statusCheckerContext, checker);
  context.set(sshRuntimeContext, {
    sshIdentityFile: '/run/secrets/id_ed25519',
    sshKnownHostsFile: '/etc/power-manager/known_hosts',
  });
  return context;
}

describe('一覧画面の loader', () => {
  test('設定順に全サーバー・グループ・初期状態・最近の実行を返す', async () => {
    const record: PowerOperationRecord = {
      at: '2026-01-02T03:04:05.000Z',
      target: { type: 'server', id: 'nas' },
      operation: 'wake',
      result: 'succeeded',
      code: null,
    };

    const data = await loader({
      context: loaderContext({
        states: new Map([['nas', 'online']]),
        recent: [record],
      }),
      params: {},
      request: new Request('http://localhost/'),
    } as never);

    // 設定ファイルの順序をそのまま保つ（FR-01）。
    expect(data.servers.map((server) => server.id)).toEqual(['nas', 'test-01']);
    expect(data.servers[1]?.groups).toEqual(['storage', 'test']);
    expect(data.groups).toEqual([
      { id: 'storage', name: 'ストレージ' },
      { id: 'test', name: '検証機' },
    ]);
    // 取得できた状態と、取得できなかった状態（unknown）が混在する。
    expect(data.states).toEqual({ nas: 'online', 'test-01': 'unknown' });
    expect(data.recent).toHaveLength(1);
  });

  test('サーバーが 0 台でも空の一覧を返す', async () => {
    const config = validManagedConfig();
    config.servers = [];
    config.groups = [];

    const data = await loader({
      context: loaderContext({ config }),
      params: {},
      request: new Request('http://localhost/'),
    } as never);

    expect(data.servers).toEqual([]);
    expect(data.groups).toEqual([]);
    expect(data.states).toEqual({});
  });
});

describe('一覧画面の action', () => {
  /** action の引数を作る。操作器は記録だけを返す偽物にする。 */
  function actionArgs(fields: Record<string, string | undefined>) {
    const operate = vi.fn(
      async (
        serverId: string,
        _target: unknown,
        operation: 'wake' | 'shutdown',
        _server: unknown,
        _runtime: unknown,
        _options?: unknown,
      ): Promise<PowerOperationRecord> => ({
        at: '2026-01-02T03:04:05.000Z',
        target: { type: 'server', id: serverId },
        operation,
        result: 'succeeded',
        code: null,
      }),
    );

    const context = loaderContext({});
    context.set(operatorContext, {
      operate,
      operateAll: async () => [],
      busyTargets: () => new Set<string>(),
      reset: () => {},
    });

    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) body.set(key, value);
    }

    return {
      operate,
      context,
      args: {
        context,
        params: {},
        request: new Request('http://localhost/', { method: 'POST', body }),
      } as never,
    };
  }

  test('intent と対象を操作器へ渡し、結果種別と対象だけを返す', async () => {
    const { operate, args } = actionArgs({ intent: 'shutdown', target: 'nas' });

    const response = (await action(args)) as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      target: 'nas',
      operation: 'shutdown',
      result: 'succeeded',
    });

    // コマンド内容・鍵・内部エラーは応答に含めない（SEC-05）。
    expect(operate).toHaveBeenCalledTimes(1);
    expect(operate.mock.calls[0]?.[0]).toBe('nas');
    expect(operate.mock.calls[0]?.[2]).toBe('shutdown');
    // SSH のパスは load context から渡る。
    expect(operate.mock.calls[0]?.[4]).toEqual({
      sshIdentityFile: '/run/secrets/id_ed25519',
      sshKnownHostsFile: '/etc/power-manager/known_hosts',
    });
  });

  test('未知のサーバー ID・未知の intent は操作せず 400 を返す', async () => {
    const cases: ReadonlyArray<Record<string, string | undefined>> = [
      { intent: 'wake', target: 'unknown-server' },
      { intent: 'reboot', target: 'nas' },
      { intent: 'wake' },
    ];

    for (const fields of cases) {
      const { operate, args } = actionArgs(fields);
      const response = (await action(args)) as Response;
      expect(response.status).toBe(400);
      expect(operate).not.toHaveBeenCalled();
    }
  });

  test('実行中（busy）は「実行中（拒否）」へ畳み込む', () => {
    expect(toResultKind({ result: 'failed', code: 'busy' })).toBe('rejected');
    // 単体操作の busy は操作器が {result:'skipped', code:'busy'} を返す
    // （app/lib/power.server.ts）。画面では「スキップ」ではなく拒否として扱う。
    expect(toResultKind({ result: 'skipped', code: 'busy' })).toBe('rejected');
    expect(toResultKind({ result: 'failed', code: 'operation_failed' })).toBe(
      'failed',
    );
    expect(toResultKind({ result: 'succeeded', code: null })).toBe('succeeded');
  });
});

describe('「最近の実行」の理由表示', () => {
  test('実行しなかった理由だけを日本語で返す', () => {
    expect(toReasonLabel({ result: 'skipped', code: 'busy' })).toBe(
      '実行中のためスキップしました',
    );
    expect(toReasonLabel({ result: 'skipped', code: 'missed_schedule' })).toBe(
      '実行時刻を過ぎたためスキップしました',
    );
  });

  test('実行して失敗した操作の理由は出さない（ログにのみ残す）', () => {
    for (const code of [
      'invalid_configuration',
      'ssh_unavailable',
      'operation_failed',
    ] as const) {
      expect(toReasonLabel({ result: 'failed', code })).toBeNull();
    }
    expect(toReasonLabel({ result: 'succeeded', code: null })).toBeNull();
  });

  test('未知の分類は表示しない', () => {
    expect(
      toReasonLabel({ result: 'skipped', code: 'unknown_code' as never }),
    ).toBeNull();
  });
});
