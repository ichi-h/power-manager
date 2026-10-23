/**
 * 設定画面と定義の再読込の検証（FR-07, FR-08, NFR-13, SEC-05）。
 *
 * ここではサーバー側の loader / action の入出力を見る（画面の描画は
 * `test/settings-screen.test.tsx`）。要点は次の 4 つ。
 *
 * - 再読込の成功で有効設定とスケジューラの計画が差し替わる。
 * - 検証に失敗したときは旧設定が維持され、画面には結果種別しか返らない。
 * - 失敗理由は `config_reload` の 1 行ログにだけ出る（値そのものは出さない）。
 * - 予約実行器が無い（production 以外）ときは計画の差し替えを行わない。
 */
import { RouterContextProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { configContext } from '../app/lib/config.server.ts';
import {
  configStoreContext,
  createConfigStore,
} from '../app/lib/config-store.server.ts';
import type { ManagedConfig } from '../app/lib/model.ts';
import { parseManagedConfig } from '../app/lib/runtime-config.server.ts';
import { scheduleRunnerContext } from '../app/lib/schedule-runner-context.server.ts';
import {
  createScheduleRunner,
  type ScheduleRunner,
} from '../app/lib/schedule.server.ts';
import { validEnvironment } from './support/environment.ts';
import { validManagedConfig, validSchedule } from './support/managed-config.ts';

import { action, headers, loader } from '../app/routes/settings.tsx';

/** テストで使う定義ファイルのパス。実際には読み書きしない（`load` を差し替える）。 */
const configPath = '/etc/power-manager/config.json';

/** 定義 JSON のうち、テストから書き換える集合に型を与える。 */
type ConfigJson = {
  servers: Record<string, unknown>[];
  groups: Record<string, unknown>[];
  schedules: Record<string, unknown>[];
};

/** 2 台・1 グループ・1 予約の定義。 */
function twoServerConfig(): ConfigJson {
  const config = validManagedConfig() as unknown as ConfigJson;
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
      groups: [],
      macAddress: '00:11:22:33:44:66',
      wol: { broadcastAddress: '255.255.255.255', port: 9 },
      ssh: {
        host: 'test-01.example.internal',
        port: 22,
        user: 'power-manager',
        shutdownCommand: 'sudo systemctl poweroff',
      },
    },
  ];
  config.groups = [{ id: 'storage', name: 'ストレージ' }];
  config.schedules = [
    validSchedule({ id: 'night-shutdown', name: '夜間停止' }),
    validSchedule({
      id: 'morning-wake',
      name: '朝の起動',
      target: { type: 'server', id: 'nas' },
      operation: 'wake',
      repeat: { kind: 'weekly', days: ['mon', 'wed'], time: '07:00' },
    }),
  ];
  return config;
}

/**
 * 予約実行器の偽物。計画の件数を `plans` で返し、差し替えで件数を更新する。
 *
 * `replacePlans` に渡された定義から「何件の計画になったか」を作りたいところだが、
 * action が確かめたいのは「差し替えが呼ばれたか」「その結果の件数がログと応答に載るか」
 * だけなので、差し替え後の件数を固定値で与える。
 */
function fakeRunner(replacedPlanCount = 0) {
  let count = 0;
  const replacePlans = vi.fn((_config: ManagedConfig) => {
    count = replacedPlanCount;
  });
  const runner = {
    replacePlans,
    plans: () => Array.from({ length: count }, () => ({})),
  };
  return { runner, replacePlans };
}

/**
 * loader / action に渡す load context。
 *
 * `runner` を省略すると production 以外と同じく `null` を載せる。
 */
function context(options: {
  config?: Record<string, unknown>;
  load?: () => Promise<ManagedConfig>;
  runner?: ReturnType<typeof fakeRunner> | null;
}) {
  const store = createConfigStore(
    configPath,
    parseManagedConfig(options.config ?? twoServerConfig()),
    async () =>
      options.load === undefined
        ? parseManagedConfig(options.config ?? twoServerConfig())
        : options.load(),
  );

  const provider = new RouterContextProvider();
  provider.set(configContext, {
    configPath,
    port: 8080,
    publicOrigin: 'https://power.example.ts.net',
    publicOriginHost: 'power.example.ts.net',
    nodeEnv: 'production',
  });
  provider.set(configStoreContext, store);
  const runner = options.runner ?? null;
  provider.set(scheduleRunnerContext, runner === null ? null : runner.runner);

  return { context: provider, store };
}

/** 再読込の action 呼び出し。 */
function reloadArgs(
  provider: RouterContextProvider,
  fields: Record<string, string> = { intent: 'reload' },
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return {
    context: provider,
    params: {},
    request: new Request('http://localhost/settings', {
      method: 'POST',
      body: form,
    }),
  } as never;
}

/** 応答本文を JSON として読む。 */
async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

describe('設定画面の loader', () => {
  test('現在のサーバー・グループ・予約を設定順に返す', () => {
    const data = loader({
      context: context({}).context,
      params: {},
      request: new Request('http://localhost/settings'),
    } as never);

    expect(data.configPath).toBe(configPath);
    expect(data.servers.map((server) => server.id)).toEqual(['nas', 'test-01']);
    expect(data.servers[0]).toEqual({
      id: 'nas',
      name: 'NAS',
      groups: ['ストレージ'],
      host: 'nas.example.internal',
      port: 22,
      macAddress: '00:11:22:33:44:55',
      broadcastAddress: '192.168.1.255',
      wolPort: 9,
    });
    expect(data.servers[1]?.groups).toEqual([]);
    expect(data.groups).toEqual([{ id: 'storage', name: 'ストレージ' }]);
    expect(data.schedules).toEqual([
      {
        id: 'night-shutdown',
        name: '夜間停止',
        enabled: true,
        operation: '停止',
        target: 'グループ storage',
        repeat: '毎日 23:30',
      },
      {
        id: 'morning-wake',
        name: '朝の起動',
        enabled: true,
        operation: '起動',
        target: 'サーバー nas',
        repeat: '毎週 月・水 07:00',
      },
    ]);
  });

  test('停止コマンドを画面用のデータへ含めない（SEC-05）', () => {
    const data = loader({
      context: context({}).context,
      params: {},
      request: new Request('http://localhost/settings'),
    } as never);

    const body = JSON.stringify(data);
    expect(body).not.toContain('systemctl poweroff');
    expect(body).not.toContain('shutdownCommand');
    expect(body).not.toContain('user');
  });

  test('サーバーが 0 台でも空の一覧を返す', () => {
    const config = validManagedConfig();
    config.servers = [];
    config.groups = [];
    config.schedules = [];

    const data = loader({
      context: context({ config }).context,
      params: {},
      request: new Request('http://localhost/settings'),
    } as never);

    expect(data.servers).toEqual([]);
    expect(data.groups).toEqual([]);
    expect(data.schedules).toEqual([]);
  });
});

describe('設定画面の応答ヘッダ', () => {
  test('loader の応答はキャッシュを許さない（SEC-05, bd05）', () => {
    const response = new Response(null, { headers: headers({ loaderHeaders: new Headers(), parentHeaders: new Headers(), actionHeaders: new Headers(), errorHeaders: undefined }) });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('定義の再読込', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('成功時は有効設定を差し替え、結果種別だけを返す', async () => {
    const reloaded = twoServerConfig();
    // 新しいグループは必ずサーバー 1 台以上を持つ（FR-11 の相互参照検証）。
    reloaded.servers[1]!.groups = ['test'];
    reloaded.groups = [
      { id: 'storage', name: 'ストレージ' },
      { id: 'test', name: '検証機' },
    ];
    reloaded.schedules = [
      validSchedule({ id: 'new-schedule' }),
      validSchedule({
        id: 'another-schedule',
        target: { type: 'server', id: 'nas' },
      }),
    ];

    const runner = fakeRunner(2);
    const built = context({
      load: async () => parseManagedConfig(reloaded),
      runner,
    });

    const response = await action(reloadArgs(built.context));

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      result: 'succeeded',
      schedules: 2,
    });
    // 有効設定が差し替わっている（旧設定ではない）。
    expect(built.store.current().groups.map((group) => group.id)).toEqual([
      'storage',
      'test',
    ]);
    expect(
      built.store.current().schedules.map((schedule) => schedule.id),
    ).toEqual(['new-schedule', 'another-schedule']);
    expect(runner.replacePlans).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? '')).toEqual({
      event: 'config_reload',
      result: 'succeeded',
      schedules: 2,
    });
  });

  test('検証に失敗したら旧設定を維持し、画面には失敗だけを返す', async () => {
    const broken = twoServerConfig();
    broken.groups = [];
    // `nas` が未定義グループを参照するため、相互参照の検証で落ちる。
    const runner = fakeRunner(0);
    const built = context({
      load: async () => parseManagedConfig(broken),
      runner,
    });

    const response = await action(reloadArgs(built.context));

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ result: 'failed' });
    // 旧設定が維持されている（グループ・予約とも起動時のまま）。
    expect(built.store.current().groups).toHaveLength(1);
    expect(built.store.current().schedules).toHaveLength(2);
    // 失敗時は計画を差し替えない。
    expect(runner.replacePlans).not.toHaveBeenCalled();
  });

  test('失敗理由はログにだけ出し、画面の応答には含めない', async () => {
    const broken = twoServerConfig();
    broken.servers[0] = {
      ...broken.servers[0]!,
      macAddress: 'not-a-mac',
    };

    const built = context({
      load: async () => parseManagedConfig(broken),
      runner: fakeRunner(0),
    });
    const response = await action(reloadArgs(built.context));

    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ result: 'failed' });

    expect(logs).toHaveLength(1);
    const logged = JSON.parse(logs[0] ?? '') as {
      event: string;
      result: string;
      reason?: string;
    };
    expect(logged.event).toBe('config_reload');
    expect(logged.result).toBe('failed');
    // 指摘は項目名と理由だけで、設定値そのもの（壊れた MAC アドレス）は含めない。
    expect(logged.reason).toBeDefined();
    expect(logged.reason).not.toContain('not-a-mac');
    expect(body).not.toContain(logged.reason ?? '<no reason>');
  });

  test('予約実行器が無いときは計画を差し替えず、schedules を省略する', async () => {
    const built = context({ runner: null });

    const response = await action(reloadArgs(built.context));

    expect(await readJson(response)).toEqual({
      result: 'succeeded',
      schedules: null,
    });
    const logged = JSON.parse(logs[0] ?? '') as Record<string, unknown>;
    expect(logged.schedules).toBeUndefined();
  });

  test('実行中の操作を中断しない（計画の差し替えだけを行う, NFR-13）', async () => {
    // 実体の実行器で、差し替えが停止（`stop`）を伴わないことを確かめる。
    const runner: ScheduleRunner = createScheduleRunner(
      parseManagedConfig(twoServerConfig()),
      {
        operator: {
          operate: async () => ({
            at: '2026-01-02T03:04:05.000Z',
            target: { type: 'server', id: 'nas' },
            operation: 'wake',
            result: 'succeeded',
            code: null,
          }),
          operateAll: async () => ({
            records: [],
            summary: { ok: 0, failed: 0, skipped: 0 },
          }),
        },
        runtime: {
          sshIdentityFile: validEnvironment().POWER_MANAGER_SSH_IDENTITY_FILE,
          sshKnownHostsFile:
            validEnvironment().POWER_MANAGER_SSH_KNOWN_HOSTS_FILE,
        },
        onRecord: () => {},
      } as never,
    );
    const stop = vi.spyOn(runner, 'stop');

    const built = context({ runner: null });
    built.context.set(scheduleRunnerContext, runner);

    const response = await action(reloadArgs(built.context));

    expect(await readJson(response)).toEqual({
      result: 'succeeded',
      schedules: 2,
    });
    expect(stop).not.toHaveBeenCalled();
    expect(runner.plans()).toHaveLength(2);
  });

  test('intent が reload でない要求は再読込せず 400 を返す', async () => {
    const runner = fakeRunner(0);
    const built = context({ runner });

    const response = await action(
      reloadArgs(built.context, { intent: 'other' }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: 'invalid_request' });
    expect(runner.replacePlans).not.toHaveBeenCalled();
    expect(logs).toHaveLength(0);
  });

  test('再読込の応答をキャッシュさせない', async () => {
    const built = context({ runner: null });
    const response = await action(reloadArgs(built.context));

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
  });
});
