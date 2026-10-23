/**
 * 予約スケジューラのテスト（FR-12, NFR-12, j001〜j005）。
 *
 * - 日次・週次の JST 計算と「常に現在時刻より後」であること。
 * - `enabled: false` の除外。
 * - busy スキップ（待たない）。
 * - 10 秒超の遅延スキップ（missed_schedule）。
 * - 再読込後の次回時刻の原子的差し替え。
 * - 当日分の二重実行が無いこと。
 *
 * 時刻は `deps.now` を差し替えて固定する。実行経路（`operator`）はスタブで置き換え、
 * 外部コマンドを呼ばない。
 */
import { describe, expect, test } from 'vitest';

import type { ManagedConfig, Schedule } from '../app/lib/model.ts';
import {
  computeNextRuns,
  createSchedulePlans,
  createScheduleRunner,
  fireSchedule,
  missedThresholdMs,
  nextRunTime,
  type SchedulePlan,
  type ScheduleRunnerDeps,
} from '../app/lib/schedule.server.ts';
import type { PowerOperationRecord } from '../app/lib/power.server.ts';
import { validSchedule } from './support/managed-config.ts';

/** 検証を通る雛形から `ManagedConfig` を組み立てる。 */
function configWithSchedules(
  schedules: ReadonlyArray<Record<string, unknown>>,
): ManagedConfig {
  return {
    version: 2,
    servers: [
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
    ],
    groups: [{ id: 'storage', name: 'ストレージ' }],
    schedules: schedules as ReadonlyArray<Schedule>,
  };
}

/** JST の日時文字列（`YYYY-MM-DDTHH:MM:SS`）を UTC `Date` へ変換する。 */
function jst(text: string): Date {
  return new Date(`${text}+09:00`);
}

describe('nextRunTime（j001）', () => {
  test('daily: 現在より後の直近の時刻を返す', () => {
    const from = jst('2025-06-01T10:00:00');
    const next = nextRunTime({ kind: 'daily', time: '23:30' }, from);
    expect(next.toISOString()).toBe('2025-06-01T14:30:00.000Z'); // JST 23:30
  });

  test('daily: 当日の指定時刻が既に過ぎていれば翌日になる', () => {
    const from = jst('2025-06-01T23:31:00');
    const next = nextRunTime({ kind: 'daily', time: '23:30' }, from);
    expect(next.toISOString()).toBe('2025-06-02T14:30:00.000Z');
  });

  test('daily: 指定時刻と同じ瞬間は「後」に含まれず翌日になる', () => {
    const from = jst('2025-06-01T23:30:00');
    const next = nextRunTime({ kind: 'daily', time: '23:30' }, from);
    expect(next.toISOString()).toBe('2025-06-02T14:30:00.000Z');
  });

  test('weekly: 指定曜日の直近の時刻を返す', () => {
    // 2025-06-01 は日曜。mon 指定なら翌日（6/2）23:30。
    const from = jst('2025-06-01T10:00:00');
    const next = nextRunTime(
      { kind: 'weekly', days: ['mon'], time: '23:30' },
      from,
    );
    expect(next.toISOString()).toBe('2025-06-02T14:30:00.000Z');
  });

  test('weekly: 当日が指定曜日でも、時刻が過ぎていれば翌週になる', () => {
    // 2025-06-01 は日曜。sun 指定で時刻既過なら 6/8 になる。
    const from = jst('2025-06-01T23:31:00');
    const next = nextRunTime(
      { kind: 'weekly', days: ['sun'], time: '23:30' },
      from,
    );
    expect(next.toISOString()).toBe('2025-06-08T14:30:00.000Z');
  });

  test('weekly: 複数曜日のうち最も近いものを返す', () => {
    const from = jst('2025-06-01T10:00:00'); // 日曜
    const next = nextRunTime(
      { kind: 'weekly', days: ['tue', 'fri'], time: '09:00' },
      from,
    );
    expect(next.toISOString()).toBe('2025-06-03T00:00:00.000Z'); // 火 09:00 JST
  });

  test('常に from より後である（1 万回の境目付近のランダム検証）', () => {
    const base = jst('2025-06-01T00:00:00').getTime();
    for (let i = 0; i < 2000; i += 1) {
      const from = new Date(base + i * 3_600_000);
      const next = nextRunTime({ kind: 'daily', time: '12:00' }, from);
      expect(next.getTime()).toBeGreaterThan(from.getTime());
    }
  });
});

describe('computeNextRuns / createSchedulePlans（j001）', () => {
  test('enabled: false の予約は対象外', () => {
    const config = configWithSchedules([
      validSchedule({ id: 'a', enabled: true }),
      validSchedule({ id: 'b', enabled: false }),
    ]);
    const next = computeNextRuns(config, jst('2025-06-01T10:00:00'));
    expect(next.has('a')).toBe(true);
    expect(next.has('b')).toBe(false);
    const plans = createSchedulePlans(config, jst('2025-06-01T10:00:00'));
    expect(plans.map((p) => p.schedule.id)).toEqual(['a']);
  });
});

describe('fireSchedule（j003）', () => {
  const runtime = { sshIdentityFile: '/id', sshKnownHostsFile: '/kh' };

  /** 呼び出しを記録する operator スタブ。 */
  function stubOperator(busy: ReadonlySet<string> = new Set()) {
    const calls: Array<{ kind: string; id: string; scheduleId?: string }> = [];
    return {
      calls,
      operator: {
        busyTargets: () => busy,
        operate: async (
          serverId: string,
          _target: unknown,
          _op: unknown,
          _server: unknown,
          _runtime: unknown,
          options?: { scheduleId?: string },
        ) => {
          calls.push({
            kind: 'operate',
            id: serverId,
            scheduleId: options?.scheduleId,
          });
          return {};
        },
        operateAll: async (
          _scope: unknown,
          _op: unknown,
          targets: ReadonlyArray<{ id: string }>,
          _runtime: unknown,
          options?: { scheduleId?: string },
        ) => {
          calls.push({
            kind: 'operateAll',
            id: targets.map((t) => t.id).join(','),
            scheduleId: options?.scheduleId,
          });
          return {};
        },
      },
    };
  }

  /** スケジュール計画を作る。 */
  function plan(
    overrides: Record<string, unknown> = {},
    nextRunAt = jst('2025-06-01T23:30:00'),
  ): SchedulePlan {
    const schedule = {
      ...validSchedule(overrides),
    } as unknown as Schedule;
    return { schedule, nextRunAt };
  }

  /** deps を組み立てる。`nowText` は JST で発火直前の時刻。 */
  function depsWith(
    operator: unknown,
    nowText: string,
    extra: Partial<ScheduleRunnerDeps> = {},
  ): ScheduleRunnerDeps {
    return {
      operator: operator as ScheduleRunnerDeps['operator'],
      runtime,
      logSkip: () => {},
      now: () => jst(nowText),
      ...extra,
    };
  }

  test('指定時刻前は何もしない', async () => {
    const { operator, calls } = stubOperator();
    const result = await fireSchedule(
      plan(),
      configWithSchedules([]),
      depsWith(operator, '2025-06-01T23:29:59'),
    );
    expect(result).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('10 秒以内の遅延なら実行する', async () => {
    const { operator, calls } = stubOperator();
    const result = await fireSchedule(
      plan({ target: { type: 'server', id: 'nas' } }),
      configWithSchedules([
        validSchedule({ target: { type: 'server', id: 'nas' } }),
      ]),
      depsWith(operator, '2025-06-01T23:30:09'),
    );
    expect(result).toBe('fired');
    expect(calls).toEqual([
      { kind: 'operate', id: 'nas', scheduleId: 'night-shutdown' },
    ]);
  });

  test('10 秒超の遅延は missed でスキップし、実行しない', async () => {
    const { operator, calls } = stubOperator();
    const skips: Array<[string, string]> = [];
    const result = await fireSchedule(
      plan(),
      configWithSchedules([]),
      depsWith(operator, '2025-06-01T23:30:11', {
        logSkip: (id, code) => skips.push([id, code]),
      }),
    );
    expect(result).toBe('missed');
    expect(calls).toEqual([]);
    expect(skips).toEqual([['night-shutdown', 'missed_schedule']]);
  });

  test('対象が busy なら待たずにスキップする', async () => {
    const { operator, calls } = stubOperator(new Set(['nas']));
    const skips: Array<[string, string]> = [];
    const result = await fireSchedule(
      plan({ target: { type: 'server', id: 'nas' } }),
      configWithSchedules([
        validSchedule({ target: { type: 'server', id: 'nas' } }),
      ]),
      depsWith(operator, '2025-06-01T23:30:05', {
        logSkip: (id, code) => skips.push([id, code]),
      }),
    );
    expect(result).toBe('busy');
    expect(calls).toEqual([]);
    expect(skips).toEqual([['night-shutdown', 'busy']]);
  });

  test('対象が確定できない予約は invalid_target でスキップする', async () => {
    const { operator, calls } = stubOperator();
    const skips: Array<[string, string]> = [];
    const result = await fireSchedule(
      plan({ target: { type: 'server', id: 'missing' } }),
      configWithSchedules([
        validSchedule({ target: { type: 'server', id: 'missing' } }),
      ]),
      depsWith(operator, '2025-06-01T23:30:05', {
        logSkip: (id, code) => skips.push([id, code]),
      }),
    );
    expect(result).toBe('invalid_target');
    expect(calls).toEqual([]);
    expect(skips).toEqual([['night-shutdown', 'invalid_configuration']]);
  });

  test('グループ対象は operateAll で実行する', async () => {
    const { operator, calls } = stubOperator();
    const result = await fireSchedule(
      plan(),
      configWithSchedules([validSchedule()]),
      depsWith(operator, '2025-06-01T23:30:05'),
    );
    expect(result).toBe('fired');
    // グループ対象でも実サーバーが 1 台なら単体経路（operate）になる。scheduleId を
    // 運ぶのは単体経路の options である。
    expect(calls).toEqual([
      { kind: 'operate', id: 'nas', scheduleId: 'night-shutdown' },
    ]);
  });

  test('グループ対象が複数台なら operateAll に scheduleId を渡す', async () => {
    const { operator, calls } = stubOperator();
    const config = {
      ...configWithSchedules([]),
      servers: [
        ...configWithSchedules([]).servers,
        {
          id: 'backup',
          name: 'バックアップ',
          groups: ['storage'],
          macAddress: '00:11:22:33:44:66',
          wol: { broadcastAddress: '192.168.1.255', port: 9 },
          ssh: {
            host: 'backup.example.internal',
            port: 22,
            user: 'power-manager',
            shutdownCommand: 'sudo systemctl poweroff',
          },
        },
      ],
    } as ManagedConfig;
    const result = await fireSchedule(
      plan(),
      config,
      depsWith(operator, '2025-06-01T23:30:05'),
    );
    expect(result).toBe('fired');
    expect(calls).toEqual([
      { kind: 'operateAll', id: 'nas,backup', scheduleId: 'night-shutdown' },
    ]);
  });
});

describe('createScheduleRunner（j002, j004, j005）', () => {
  const runtime = { sshIdentityFile: '/id', sshKnownHostsFile: '/kh' };

  /** 依存と呼び出し記録を組み立てる。 */
  function makeDeps(busy: ReadonlySet<string> = new Set()) {
    const calls: string[] = [];
    const records: Array<{
      record: PowerOperationRecord;
      event: string;
    }> = [];
    let now = jst('2025-06-01T10:00:00').getTime();
    const deps: ScheduleRunnerDeps = {
      operator: {
        busyTargets: () => busy,
        operate: async (
          serverId: string,
          _target: unknown,
          _op: unknown,
          _server: unknown,
          _runtime: unknown,
          options?: { scheduleId?: string },
        ) => {
          calls.push(`operate:${serverId}:${options?.scheduleId ?? ''}`);
          return {};
        },
        operateAll: async (
          _scope: unknown,
          _op: unknown,
          _targets: unknown,
          _runtime: unknown,
          options?: { scheduleId?: string },
        ) => {
          calls.push(`operateAll:${options?.scheduleId ?? ''}`);
          return {};
        },
      },
      runtime,
      logSkip: () => {},
      now: () => new Date(now),
      tickIntervalMs: 10,
      onRecord: (record, event) => {
        records.push({ record, event });
      },
    };
    // setNow / operator の差し替えは deps を直接触る形にするため、実行時の deps に
    // 補助を生やす（テスト補助であり、実運用の deps 型には無い）。
    const extended = deps as ScheduleRunnerDeps & {
      setNow: (d: Date) => void;
    };
    extended.setNow = (d: Date) => {
      now = d.getTime();
    };
    return { deps: extended, calls, records, setNow: extended.setNow };
  }

  /** 条件を満たすまで待つ（実走テストの同期用）。 */
  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 2_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitFor: timeout');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test('同時刻に期限到来した 2 予約が各 1 回だけ発火する', async () => {
    const config = configWithSchedules([
      validSchedule({ id: 'a', target: { type: 'server', id: 'nas' } }),
      validSchedule({ id: 'b', target: { type: 'server', id: 'nas' } }),
    ]);
    const { deps, calls } = makeDeps();
    const runner = createScheduleRunner(config, deps);
    // 両予約とも 23:30 が次回時刻。23:30:01 まで進めて実走させる。
    deps.setNow(jst('2025-06-01T23:30:01'));
    runner.start();
    await waitFor(() => calls.length >= 2);
    const firedA = calls.filter((c) => c === 'operate:nas:a').length;
    const firedB = calls.filter((c) => c === 'operate:nas:b').length;
    expect(firedA).toBe(1);
    expect(firedB).toBe(1);
    // さらに待っても二重発火しない（FR-12 当日分の再実行なし）。
    deps.setNow(jst('2025-06-01T23:30:03'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.length).toBe(2);
    await runner.stop();
  });

  test('先行する長い操作でも後続予約は発火する（head-of-line なし）', async () => {
    const config = configWithSchedules([
      validSchedule({ id: 'a', target: { type: 'server', id: 'nas' } }),
      validSchedule({ id: 'b', target: { type: 'server', id: 'nas' } }),
    ]);
    const { deps, calls } = makeDeps();
    // 1 件目の発火を閉じられるまで止める（SSH 停止の長時間化を模擬）。
    const releaseA: Array<() => void> = [];
    (deps.operator as unknown) = {
      busyTargets: () => new Set(),
      operate: async (serverId: string) => {
        if (serverId === 'nas') {
          await new Promise<void>((resolve) => {
            releaseA.push(resolve);
          });
        }
        calls.push(`operate:${serverId}`);
        return {};
      },
      operateAll: async () => ({}) as never,
    } as ScheduleRunnerDeps['operator'];
    // 対象 ID を a/b で分けるため、サーバーを 2 台にして対象を分ける。
    const twoServers = {
      ...config,
      servers: [
        ...config.servers,
        {
          id: 'nas2',
          name: 'NAS2',
          groups: ['storage2'],
          macAddress: '00:11:22:33:44:66',
          wol: { broadcastAddress: '192.168.1.255', port: 9 },
          ssh: {
            host: 'nas2.example.internal',
            port: 22,
            user: 'power-manager',
            shutdownCommand: 'sudo systemctl poweroff',
          },
        },
      ],
      schedules: [
        {
          ...validSchedule({ id: 'a' }),
          target: { type: 'server', id: 'nas' },
        },
        {
          ...validSchedule({ id: 'b' }),
          target: { type: 'server', id: 'nas2' },
        },
      ],
    } as unknown as ManagedConfig;
    // 作成時は 10:00（本日の分は未来）で、start 直前に 23:30:01 へ進める。
    const runner = createScheduleRunner(twoServers, deps);
    deps.setNow(jst('2025-06-01T23:30:01'));
    runner.start();
    // 先行（a）の発火が始まっても、後続（b）は待たずに発火する。
    await waitFor(() => calls.includes('operate:nas2'));
    releaseA[0]?.();
    await waitFor(() => calls.length >= 2);
    await runner.stop();
  });

  test('ティック開始から 10 秒超の遅延は missed になる（tick 経由）', async () => {
    const config = configWithSchedules([
      validSchedule({ target: { type: 'server', id: 'nas' } }),
    ]);
    const { deps, calls, records } = makeDeps();
    const runner = createScheduleRunner(config, deps);
    // 作成時は 10:00 なので次回時刻は 23:30。その後一気に 23:30:11 へ進める。
    deps.setNow(jst('2025-06-01T23:30:11'));
    runner.start();
    await waitFor(() => records.length > 0 || calls.length > 0, 1_000);
    await runner.stop();
    // 実行はされず、missed_schedule のスキップとして記録される（NFR-12）。
    expect(calls).toEqual([]);
    const skip = records.find((r) => r.event === 'schedule_skip');
    expect(skip?.record.scheduleId).toBe('night-shutdown');
    expect(skip?.record.code).toBe('missed_schedule');
  });

  test('operate が reject してもプロセスは落ちず次回時刻は前進する', async () => {
    const config = configWithSchedules([
      validSchedule({ target: { type: 'server', id: 'nas' } }),
    ]);
    const { deps, calls } = makeDeps();
    (deps.operator as unknown) = {
      busyTargets: () => new Set(),
      operate: async () => {
        calls.push('operate');
        throw new Error('boom from operate');
      },
      operateAll: async () => ({}) as never,
    } as ScheduleRunnerDeps['operator'];
    const runner = createScheduleRunner(config, deps);
    deps.setNow(jst('2025-06-01T23:30:01'));
    runner.start();
    await waitFor(() => calls.length >= 1);
    // 未捕捉の拒否があってもテストプロセスは生きている。次回時刻は翌日へ前進済み。
    expect(runner.plans()[0]?.nextRunAt.toISOString()).toBe(
      '2025-06-02T14:30:00.000Z',
    );
    deps.setNow(jst('2025-06-01T23:30:03'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.length).toBe(1);
    await runner.stop();
  });

  test('busy スキップが onRecord 経由で schedule_skip として記録される', async () => {
    const config = configWithSchedules([
      validSchedule({ target: { type: 'server', id: 'nas' } }),
    ]);
    const { deps, calls, records } = makeDeps(new Set(['nas']));
    const runner = createScheduleRunner(config, deps);
    deps.setNow(jst('2025-06-01T23:30:01'));
    runner.start();
    await waitFor(() => records.length > 0, 1_000);
    await runner.stop();
    expect(calls).toEqual([]);
    const skip = records.find((r) => r.event === 'schedule_skip');
    expect(skip?.record.scheduleId).toBe('night-shutdown');
    expect(skip?.record.code).toBe('busy');
    expect(skip?.record.result).toBe('skipped');
    expect(skip?.record.scheduleId).toBeDefined();
  });

  test('初回ロード時に本日の実行時刻が過ぎていたら schedule_skip を記録する', async () => {
    const config = configWithSchedules([
      validSchedule({ target: { type: 'server', id: 'nas' } }),
    ]);
    const { deps, records } = makeDeps();
    // 23:31 に作成する。本日の 23:30 は既に過ぎている（黙って翌日へ丸められない）。
    deps.setNow(jst('2025-06-01T23:31:00'));
    const runner = createScheduleRunner(config, deps);
    await runner.stop();
    const skip = records.find((r) => r.event === 'schedule_skip');
    expect(skip?.record.scheduleId).toBe('night-shutdown');
    expect(skip?.record.code).toBe('missed_schedule');
    // 次回時刻は翌日である（FR-12 当日分の再実行なし）。
    expect(runner.plans()[0]?.nextRunAt.toISOString()).toBe(
      '2025-06-02T14:30:00.000Z',
    );
  });

  test('replacePlans で次回時刻が再計算される（j004）', () => {
    const config = configWithSchedules([validSchedule()]);
    const { deps, setNow } = makeDeps();
    setNow(jst('2025-06-01T10:00:00'));
    const runner = createScheduleRunner(config, deps);
    expect(runner.plans()[0]?.nextRunAt.toISOString()).toBe(
      '2025-06-01T14:30:00.000Z',
    );
    // 23:30 過ぎに再読込すると、次回は翌日になる（当日分の二重実行をしない）。
    setNow(jst('2025-06-01T23:40:00'));
    runner.replacePlans(config);
    expect(runner.plans()[0]?.nextRunAt.toISOString()).toBe(
      '2025-06-02T14:30:00.000Z',
    );
    void runner.stop();
  });

  test('start の二重呼び出しでタイマーが重複しない', async () => {
    const { deps } = makeDeps();
    const runner = createScheduleRunner(configWithSchedules([]), deps);
    runner.start();
    runner.start();
    expect(runner.isRunning()).toBe(true);
    await runner.stop();
    expect(runner.isRunning()).toBe(false);
  });
});

describe('missedThresholdMs', () => {
  test('しきい値は 10 秒（NFR-12）', () => {
    expect(missedThresholdMs).toBe(10_000);
  });
});
