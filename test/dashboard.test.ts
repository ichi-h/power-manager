/**
 * 一覧画面の loader / action の検証（FR-01, FR-04, FR-05, FR-07, FR-13）。
 *
 * 画面の描画（行内の進行表示・自動更新・確認ダイアログ）は
 * `test/dashboard-screen.test.tsx` と `test/routes.test.tsx` が検証する。
 * ここではサーバー側の入出力だけを見る。
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
import { CONFIRM_INTENT } from '../app/lib/confirm.ts';
import { operatorContext } from '../app/lib/operator-context.server.ts';
import { parseManagedConfig } from '../app/lib/runtime-config.server.ts';
import type {
  BatchOperationOutcome,
  BatchOperationScope,
  PowerOperationRecord,
  StatusChecker,
} from '../app/lib/power.server.ts';
import { sshRuntimeContext } from '../app/lib/ssh-runtime-context.server.ts';
import { statusCheckerContext } from '../app/lib/status-checker-context.ts';
import {
  action,
  isBatchOperationFailure,
  isBatchOperationResult,
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
    // クエリに結果が無ければ結果は表示しない（NFR-09）。
    expect(data.result).toBeNull();
  });

  test('クエリから通常フォーム送信の結果を組み立て、操作は再実行しない（NFR-09）', async () => {
    const { operate } = actionArgs({});
    const data = await loader({
      context: loaderContext({}),
      params: {},
      request: new Request(
        'http://localhost/?kind=single&operation=wake&resultKind=succeeded&target=nas',
      ),
    } as never);

    expect(data.result).toEqual({
      kind: 'single',
      operation: 'wake',
      result: 'succeeded',
      target: 'nas',
    });
    // loader が操作を呼ぶことは無い（Post/Redirect/Get）。
    expect(operate).not.toHaveBeenCalled();
  });

  test('未知の語彙・壊れたクエリでは結果を表示しない', async () => {
    const searches = [
      '?kind=single&operation=reboot&resultKind=succeeded&target=nas',
      '?kind=single&operation=wake&resultKind=bogus&target=nas',
      '?kind=single&operation=wake&resultKind=succeeded',
      '?kind=error',
      '?kind=error&reason=unknown',
      '?kind=bogus',
    ];

    for (const search of searches) {
      const data = await loader({
        context: loaderContext({}),
        params: {},
        request: new Request(`http://localhost/${search}`),
      } as never);
      expect(data.result, search).toBeNull();
    }
  });

  test('一括の結果は要約と対象ごとの結果が揃っているときだけ表示する', async () => {
    const value =
      'kind=batch&operation=wake&scopeKind=all&summary=1%2C0%2C1&count=2&item=nas%3Asucceeded%3A&item=test-01%3Askipped%3Abusy';

    const data = await loader({
      context: loaderContext({}),
      params: {},
      request: new Request(`http://localhost/?${value}`),
    } as never);

    expect(data.result).toEqual({
      kind: 'batch',
      scope: { type: 'all' },
      operation: 'wake',
      results: [
        { target: 'nas', operation: 'wake', result: 'succeeded', code: null },
        {
          target: 'test-01',
          operation: 'wake',
          result: 'skipped',
          code: 'busy',
        },
      ],
      summary: { ok: 1, failed: 0, skipped: 1 },
    });

    // 要約・件数が食い違うクエリは表示しない（手で書き換えた URL）。
    for (const extra of [
      '&summary=1%2C0%2C1',
      '&count=3',
      '&count=x',
      '&summary=2%2C0%2C1',
    ]) {
      const broken = await loader({
        context: loaderContext({}),
        params: {},
        request: new Request(`http://localhost/?${value}${extra}`),
      } as never);
      expect(broken.result, extra).toBeNull();
    }
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

/**
 * action の引数を作る。操作器は記録だけを返す偽物にする。
 *
 * `operateAll` を渡すと一括操作の応答を差し替えられる（既定は空の対象集合）。
 */
function actionArgs(
  fields: Record<string, string | undefined>,
  options: {
    operateAll?: (
      scope: BatchOperationScope,
      operation: 'wake' | 'shutdown',
      targets: ReadonlyArray<{ readonly id: string }>,
      runtime: unknown,
    ) => Promise<BatchOperationOutcome>;
    config?: Record<string, unknown>;
    /** 要求の `Accept`。通常フォーム送信（`text/html`）と fetcher を分ける。 */
    accept?: string;
    /**
     * 停止の確認を経由していない要求として送る（FR-05, SEC-07）。
     *
     * 既定では停止の intent に確認済みの値（`CONFIRM_INTENT`）を足し、確認ページを
     * 経由した要求として扱う。確認を欠いた要求の扱いを試すときだけ真にする。
     */
    unconfirmed?: boolean;
  } = {},
) {
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

  // 呼び出し内容（対象集合・並び順）を確かめられるよう、常にモックで包む。
  const operateAll = vi.fn(
    options.operateAll ??
      (async () => ({
        records: [],
        summary: { ok: 0, failed: 0, skipped: 0 },
      })),
  );

  const context = loaderContext({ config: options.config });
  context.set(operatorContext, {
    operate,
    operateAll,
    busyTargets: () => new Set<string>(),
    reset: () => {},
  });

  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(key, value);
  }
  // 停止は確認ページを経由した要求にだけ実行する（FR-05, SEC-07）。既定では
  // 確認ページの送信を模して確認済みの値を足す。
  if (
    options.unconfirmed !== true &&
    String(fields.intent).startsWith('shutdown')
  ) {
    body.set('confirmedIntent', CONFIRM_INTENT);
  }

  return {
    operate,
    operateAll,
    context,
    args: {
      context,
      params: {},
      request: new Request('http://localhost/', {
        method: 'POST',
        body,
        headers:
          options.accept === undefined ? undefined : { accept: options.accept },
      }),
    } as never,
  };
}

/** 一括操作が全対象で成功する偽の実行器。 */
const batchSucceeds: (
  scope: BatchOperationScope,
  operation: 'wake' | 'shutdown',
  targets: ReadonlyArray<{ readonly id: string }>,
  runtime: unknown,
) => Promise<BatchOperationOutcome> = async (_scope, operation, targets) => ({
  records: targets.map((target) => ({
    at: '2026-01-02T03:04:05.000Z',
    target: { type: 'server' as const, id: target.id },
    operation,
    result: 'succeeded' as const,
    code: null,
  })),
  summary: { ok: targets.length, failed: 0, skipped: 0 },
});

describe('一覧画面の action', () => {
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

  test('通常フォーム送信には 303 で結果を載せた一覧へ戻す（NFR-09）', async () => {
    const { operate, args } = actionArgs(
      { intent: 'shutdown', target: 'nas' },
      { accept: 'text/html,application/xhtml+xml' },
    );

    const response = (await action(args)) as Response;

    expect(response.status).toBe(303);
    // 操作は 1 回だけ実行し、応答本文は持たない（Post/Redirect/Get）。
    expect(operate).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe('');
    const location = new URL(
      response.headers.get('location') ?? '',
      'http://localhost',
    );
    expect(location.pathname).toBe('/');
    expect(location.searchParams.get('kind')).toBe('single');
    expect(location.searchParams.get('operation')).toBe('shutdown');
    expect(location.searchParams.get('resultKind')).toBe('succeeded');
    expect(location.searchParams.get('target')).toBe('nas');
  });

  test('fetcher の要求（text/html を含まない Accept）には JSON を返す', async () => {
    const { args } = actionArgs(
      { intent: 'wake', target: 'nas' },
      { accept: '*/*' },
    );

    const response = (await action(args)) as Response;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      target: 'nas',
      operation: 'wake',
      result: 'succeeded',
    });
  });

  test('通常フォーム送信の不正要求も 303 で戻し、応答本文を晒さない（NFR-09）', async () => {
    const { operate, args } = actionArgs(
      { intent: 'reboot', target: 'nas' },
      { accept: 'text/html' },
    );

    const response = (await action(args)) as Response;

    expect(response.status).toBe(303);
    expect(operate).not.toHaveBeenCalled();
    const location = new URL(
      response.headers.get('location') ?? '',
      'http://localhost',
    );
    expect(location.searchParams.get('kind')).toBe('error');
    expect(location.searchParams.get('reason')).toBe('invalid_request');
  });

  test('単体操作の 303 Location で loader を呼ぶと、結果を復元して表示できる（NFR-09）', async () => {
    const { args } = actionArgs(
      { intent: 'shutdown', target: 'nas' },
      { accept: 'text/html' },
    );

    const response = (await action(args)) as Response;
    expect(response.status).toBe(303);

    const location = response.headers.get('location') ?? '';
    const data = await loader({
      context: loaderContext({}),
      params: {},
      request: new Request(`http://localhost${location}`),
    } as never);

    expect(data.result).toEqual({
      kind: 'single',
      operation: 'shutdown',
      result: 'succeeded',
      target: 'nas',
    });
  });

  test('区切り文字入り ID でも 303 の往復で結果を復元できる（NFR-09）', async () => {
    const config = twoServerConfig() as {
      servers: Array<{ id: string; name: string; groups: string[] }>;
    };
    config.servers[0]!.id = 'nas:1';
    config.servers[0]!.name = 'NAS 1';
    config.servers[1]!.id = 'nas;1';
    config.servers[1]!.name = 'NAS 2';

    const cases: ReadonlyArray<{
      readonly fields: Record<string, string | undefined>;
      readonly expected: Record<string, unknown>;
    }> = [
      {
        fields: { intent: 'shutdown', target: 'nas:1' },
        expected: {
          kind: 'single',
          operation: 'shutdown',
          result: 'succeeded',
          target: 'nas:1',
        },
      },
      {
        fields: { intent: 'shutdown', target: 'nas;1' },
        expected: {
          kind: 'single', // 単体はセミコロンを使わないため復元できる
          operation: 'shutdown',
          result: 'succeeded',
          target: 'nas;1',
        },
      },
      {
        fields: {
          intent: 'wake-group',
          scopeKind: 'group',
          scopeId: 'nas|x',
        },
        expected: {
          kind: 'batch',
          scope: { type: 'group', id: 'nas|x' },
          operation: 'wake',
          results: [
            {
              target: 'nas:1',
              operation: 'wake',
              result: 'succeeded',
              code: null,
            },
          ],
          summary: { ok: 1, failed: 0, skipped: 0 },
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const config = twoServerConfig() as {
        servers: Array<{ id: string; name: string; groups: string[] }>;
        groups: Array<{ id: string; name: string }>;
      };
      config.servers[0]!.id = 'nas:1';
      config.servers[0]!.name = 'NAS 1';
      config.servers[1]!.id = 'nas;1';
      config.servers[1]!.name = '事前準備で変更したサーバー';
      if (index === 2) {
        // サーバー 0 台は「groups に所属するサーバーが無い」として検証を通らないため、
        // nas:1 を nas|x に所属させる。nas:1 は区切り文字入りで target に使う。
        config.groups = [{ id: 'nas|x', name: 'パイプ入りのグループ' }];
        config.servers[0]!.groups = ['nas|x'];
        config.servers = [config.servers[0]!];
      }

      const { args } = actionArgs(testCase.fields, {
        accept: 'text/html',
        config,
        operateAll: async (_scope, _operation, targets) => ({
          records: targets.map((target) => ({
            at: '2026-01-02T03:04:05.000Z',
            target: { type: 'server', id: target.id },
            operation: 'wake',
            result: 'succeeded',
            code: null,
          })),
          summary: { ok: config.servers.length, failed: 0, skipped: 0 },
        }),
      });
      const response = (await action(args)) as Response;
      expect(response.status, `case ${index}`).toBe(303);

      const location = response.headers.get('location') ?? '';
      const data = await loader({
        context: loaderContext({ config }),
        params: {},
        request: new Request(`http://localhost${location}`),
      } as never);
      expect(data.result, `case ${index}`).toEqual(testCase.expected);
    }
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

  test('一括操作は busy もスキップへ畳み込む（FR-11）', () => {
    // 単体操作の busy は「拒否」だが、一括では対象から外したことを「スキップ」と出す。
    expect(toResultKind({ result: 'skipped', code: 'busy' }, 'batch')).toBe(
      'skipped',
    );
    expect(
      toResultKind({ result: 'failed', code: 'operation_failed' }, 'batch'),
    ).toBe('failed');
    expect(toResultKind({ result: 'succeeded', code: null }, 'batch')).toBe(
      'succeeded',
    );
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

describe('一括操作の action', () => {
  test('通常フォーム送信の一括は 303 で範囲・操作・対象ごとの結果を戻す（NFR-09）', async () => {
    const { operateAll, args } = actionArgs(
      { intent: 'wake-group', scopeKind: 'all' },
      { accept: 'text/html', operateAll: batchSucceeds },
    );

    const response = (await action(args)) as Response;

    expect(response.status).toBe(303);
    expect(operateAll).toHaveBeenCalledTimes(1);
    const location = new URL(
      response.headers.get('location') ?? '',
      'http://localhost',
    );
    expect(location.pathname).toBe('/');
    expect(location.searchParams.get('kind')).toBe('batch');
    expect(location.searchParams.get('scopeKind')).toBe('all');
    expect(location.searchParams.get('operation')).toBe('wake');
    expect(location.searchParams.getAll('item')).toEqual([
      'nas:succeeded:',
      'test-01:succeeded:',
    ]);
    // 要約と件数を載せ、戻り先が件数の食い違いを検出できるようにする。
    expect(location.searchParams.get('summary')).toBe('2,0,0');
    expect(location.searchParams.get('count')).toBe('2');
  });

  test('通常フォーム送信の一括失敗も 303 で理由だけを戻す（NFR-09）', async () => {
    const { operateAll, args } = actionArgs(
      { intent: 'wake-group', scopeKind: 'group' },
      { accept: 'text/html' },
    );

    const response = (await action(args)) as Response;

    expect(response.status).toBe(303);
    expect(operateAll).not.toHaveBeenCalled();
    const location = new URL(
      response.headers.get('location') ?? '',
      'http://localhost',
    );
    expect(location.searchParams.get('kind')).toBe('error');
    expect(location.searchParams.get('reason')).toBe('invalid_request');
  });

  test('グループ一括は対象を ID で重複排除し、対象ごとの結果と要約を返す', async () => {
    const { operateAll, args } = actionArgs(
      { intent: 'shutdown-group', scopeKind: 'group', scopeId: 'storage' },
      {
        operateAll: async (_scope, operation, targets) => ({
          records: targets.map((target) => ({
            at: '2026-01-02T03:04:05.000Z',
            target: { type: 'server' as const, id: target.id },
            operation,
            result: 'succeeded' as const,
            code: null,
          })),
          summary: { ok: targets.length, failed: 0, skipped: 0 },
        }),
      },
    );

    const response = (await action(args)) as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      target: { type: 'group', id: 'storage' },
      operation: 'shutdown',
      results: [
        {
          target: 'nas',
          operation: 'shutdown',
          result: 'succeeded',
          code: null,
        },
        {
          target: 'test-01',
          operation: 'shutdown',
          result: 'succeeded',
          code: null,
        },
      ],
      summary: { ok: 2, failed: 0, skipped: 0 },
    });

    expect(operateAll).toHaveBeenCalledTimes(1);
    const [scope, operation, targets, runtime] = operateAll.mock.calls[0]!;
    expect(scope).toEqual({ type: 'group', id: 'storage' });
    expect(operation).toBe('shutdown');
    expect(targets.map((target: { readonly id: string }) => target.id)).toEqual(
      ['nas', 'test-01'],
    );
    // 秘密値は応答に含めず、load context から操作器へ渡す（SEC-05）。
    expect(runtime).toEqual({
      sshIdentityFile: '/run/secrets/id_ed25519',
      sshKnownHostsFile: '/etc/power-manager/known_hosts',
    });
  });

  test('全台一括は scopeKind=all で全サーバーを対象にする', async () => {
    const { operateAll, args } = actionArgs(
      { intent: 'wake-group', scopeKind: 'all' },
      {
        operateAll: async () => ({
          records: [],
          summary: { ok: 0, failed: 2, skipped: 0 },
        }),
      },
    );

    const response = (await action(args)) as Response;
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      target: unknown;
      operation: string;
      summary: unknown;
    };
    expect(body.target).toEqual({ type: 'all' });
    expect(body.operation).toBe('wake');
    // 部分失敗でも全体を失敗（500 等）に読み替えず、要約で示す。
    expect(body.summary).toEqual({ ok: 0, failed: 2, skipped: 0 });
    expect(operateAll).toHaveBeenCalledTimes(1);
    expect(operateAll.mock.calls[0]?.[0]).toEqual({ type: 'all' });
    expect(
      operateAll.mock.calls[0]?.[2].map(
        (target: { readonly id: string }) => target.id,
      ),
    ).toEqual(['nas', 'test-01']);
  });

  test('グループ ID が all でも全台一括と取り違えず、グループの対象だけを操作する', async () => {
    // グループ ID に予約語は無い（docs/operations.md 2.2）。文字列 1 つで範囲を受けると
    // このグループの一括が全台一括になるため、種別と ID を分けて受ける。
    const config = twoServerConfig();
    // サーバー 2 台を定義し、2 台目だけをグループ all に所属させる。1 台目（nas）が
    // 対象に混ざれば、グループ一括が全台一括として実行されたことになる。
    const baseServers = config.servers as unknown as ReadonlyArray<
      Record<string, unknown>
    >;
    config.servers = [
      { ...baseServers[0], groups: ['storage'] },
      { ...baseServers[1], groups: ['all'] },
    ];
    config.groups = [
      { id: 'storage', name: 'ストレージ' },
      { id: 'all', name: '全台と同名のグループ' },
    ];

    const { operateAll, args } = actionArgs(
      { intent: 'shutdown-group', scopeKind: 'group', scopeId: 'all' },
      { config },
    );

    const response = (await action(args)) as Response;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { target: unknown };

    expect(body.target).toEqual({ type: 'group', id: 'all' });
    expect(operateAll).toHaveBeenCalledTimes(1);
    expect(operateAll.mock.calls[0]?.[0]).toEqual({ type: 'group', id: 'all' });
    // 全台（nas を含む）ではなく、グループ all に所属する test-01 だけが対象になる。
    expect(
      operateAll.mock.calls[0]?.[2].map(
        (target: { readonly id: string }) => target.id,
      ),
    ).toEqual(['test-01']);
  });

  test('busy の対象は skipped として要約に数える', async () => {
    const { args } = actionArgs(
      { intent: 'shutdown-group', scopeKind: 'group', scopeId: 'test' },
      {
        operateAll: async (_scope, operation) => ({
          records: [
            {
              at: '2026-01-02T03:04:05.000Z',
              target: { type: 'server' as const, id: 'test-01' },
              operation,
              result: 'skipped' as const,
              code: 'busy' as const,
            },
          ],
          summary: { ok: 0, failed: 0, skipped: 1 },
        }),
      },
    );

    const body = (await (await action(args))!.json()) as {
      results: ReadonlyArray<{ result: string }>;
      summary: unknown;
    };
    // 一括の busy は「拒否」ではなく「スキップ」と出す（FR-11）。
    expect(body.results).toEqual([
      {
        target: 'test-01',
        operation: 'shutdown',
        result: 'skipped',
        code: 'busy',
      },
    ]);
    expect(body.summary).toEqual({ ok: 0, failed: 0, skipped: 1 });
  });

  test('未知のグループ・scopeKind/scopeId の欠落は操作せず 400 を返す', async () => {
    const cases: ReadonlyArray<Record<string, string | undefined>> = [
      { intent: 'wake-group', scopeKind: 'group', scopeId: 'unknown-group' },
      { intent: 'shutdown-group' },
      // 種別が未知の値なら解釈しない（グループ ID の文字列を種別として受け取らない）。
      { intent: 'wake-group', scopeKind: 'storage' },
      // グループ一括で ID が無い／空なら対象を確定できない。
      { intent: 'wake-group', scopeKind: 'group' },
      { intent: 'wake-group', scopeKind: 'group', scopeId: '' },
    ];

    for (const fields of cases) {
      const { operateAll, args } = actionArgs(fields);
      const response = (await action(args)) as Response;
      expect(response.status).toBe(400);
      // 一括の応答は成功と失敗の union にする。失敗形は `error` と利用者向けの
      // `message` を持ち、画面はそれをメッセージ表示に使う。
      expect(await response.json()).toEqual({
        error: 'invalid_request',
        message: expect.any(String),
      });
      expect(operateAll).not.toHaveBeenCalled();
    }
  });

  test('一括でない intent は一括の実行経路に入らない', async () => {
    // 種別が付いていても、一括の intent（`*-group`）でなければ単体操作として扱う。
    const { operateAll, args } = actionArgs({
      intent: 'reboot-group',
      scopeKind: 'all',
    });
    const response = (await action(args)) as Response;
    expect(response.status).toBe(400);
    expect(operateAll).not.toHaveBeenCalled();
  });

  test('対象が 0 台の一括は操作せず 400 を返す', async () => {
    const empty = twoServerConfig();
    empty.servers = [];
    empty.groups = [];
    const { operateAll, args } = actionArgs(
      { intent: 'wake-group', scopeKind: 'all' },
      { config: empty as never },
    );

    const response = (await action(args)) as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      message: expect.any(String),
    });
    expect(operateAll).not.toHaveBeenCalled();
  });

  test('確認した集合と確定した集合が違えば操作せず 409 を返す', async () => {
    // 確認ダイアログに 2 台を出したあとで対象が 1 台に減った場合を模す。
    const { operateAll, args } = actionArgs({
      intent: 'shutdown-group',
      scopeKind: 'group',
      scopeId: 'storage',
      confirmed: 'nas',
    });
    // 呼び出し側の確認集合は nas だけだが、storage の確定集合は nas と test-01。
    const response = (await action(args)) as Response;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'targets_changed',
      message: expect.any(String),
    });
    expect(operateAll).not.toHaveBeenCalled();
  });

  test('確認した集合が確定した集合と同じなら操作する', async () => {
    const { operateAll, args } = actionArgs(
      {
        intent: 'shutdown-group',
        scopeKind: 'group',
        scopeId: 'storage',
        confirmed: 'nas,test-01',
      },
      {
        operateAll: async (_scope, operation, targets) => ({
          records: targets.map((target) => ({
            at: '2026-01-02T03:04:05.000Z',
            target: { type: 'server' as const, id: target.id },
            operation,
            result: 'succeeded' as const,
            code: null,
          })),
          summary: { ok: targets.length, failed: 0, skipped: 0 },
        }),
      },
    );

    const response = (await action(args)) as Response;
    expect(response.status).toBe(200);
    expect(operateAll).toHaveBeenCalledTimes(1);
  });

  test('確認を経ていない停止は操作せず確認ページへ送り返す（FR-05, SEC-07）', async () => {
    // スクリプト無効の通常フォーム送信でも、確認ページの送信ボタン以外は停止しない。
    const cases: ReadonlyArray<{
      readonly fields: Record<string, string | undefined>;
      readonly expected: Record<string, string>;
    }> = [
      {
        fields: { intent: 'shutdown', target: 'nas' },
        expected: { kind: 'server', target: 'nas' },
      },
      {
        fields: {
          intent: 'shutdown-group',
          scopeKind: 'group',
          scopeId: 'storage',
        },
        expected: { kind: 'batch', scopeKind: 'group', scopeId: 'storage' },
      },
      {
        fields: { intent: 'shutdown-group', scopeKind: 'all' },
        expected: { kind: 'batch', scopeKind: 'all' },
      },
    ];

    for (const testCase of cases) {
      const { operate, operateAll, args } = actionArgs(testCase.fields, {
        unconfirmed: true,
      });

      const response = (await action(args)) as Response;

      // fetcher からの要求にも 303 を返し、画面を確認ページへ遷移させる。
      expect(response.status).toBe(303);
      const location = new URL(
        response.headers.get('location') ?? '',
        'http://localhost',
      );
      expect(location.pathname).toBe('/confirm');
      for (const [key, value] of Object.entries(testCase.expected)) {
        expect(location.searchParams.get(key)).toBe(value);
      }
      expect(operate).not.toHaveBeenCalled();
      expect(operateAll).not.toHaveBeenCalled();
    }
  });

  test('起動は確認を挟まずに操作する（FR-05）', async () => {
    const { operate, args } = actionArgs({ intent: 'wake', target: 'nas' });

    const response = (await action(args)) as Response;

    expect(response.status).toBe(200);
    expect(operate).toHaveBeenCalledTimes(1);
  });

  test('成功応答と失敗応答を取り違えない（画面の型判定）', () => {
    const success = {
      target: { type: 'all' },
      operation: 'wake',
      results: [],
      summary: { ok: 0, failed: 0, skipped: 0 },
    };
    expect(isBatchOperationResult(success)).toBe(true);
    expect(isBatchOperationFailure(success)).toBe(false);

    const failure = {
      error: 'invalid_request',
      message: '対象を確定できません',
    };
    expect(isBatchOperationFailure(failure)).toBe(true);
    // 失敗応答で要約を読むと描画時に例外になるため、成功と判定しない。
    expect(isBatchOperationResult(failure)).toBe(false);
    expect(isBatchOperationResult(undefined)).toBe(false);
    expect(isBatchOperationResult(null)).toBe(false);
    expect(isBatchOperationResult({ summary: null })).toBe(false);
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
