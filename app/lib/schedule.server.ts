/**
 * 予約の次回実行時刻の計算（FR-12, `docs/architecture.md` 6.5）。
 *
 * 定義（毎日／毎週＋時刻）と現在時刻から Asia/Tokyo 固定で「常に現在時刻より後の
 * 直近の時刻」を計算する（CON-08）。夏時間やタイムゾーン設定の変更は考慮しない。
 * アジア/東京は夏時間を持たないため、UTC とのオフセットは常に +09:00 である。
 *
 * このモジュールは時刻計算だけを担い、発火・実行は `startScheduleRunner`
 * （同じく `app/lib/schedule.server.ts`）が行う。`enabled: false` の予約は
 * 対象外とする（次回時刻を計算しない）。
 */
import type { PowerOperationRecord } from './power.server.ts';
import type { OperableServer } from './power.server.ts';
import type { ManagedConfig, Repeat, Schedule, Weekday } from './model.ts';

/**
 * Asia/Tokyo の UTC オフセット（ミリ秒）。
 *
 * 日本は夏時間を採用したことがなく、オフセットは固定である。ここを唯一の定数とし、
 * 計算はすべて UTC 軸上で行う（現地暦の `Date` 操作に頼らない）。
 */
const tokyoOffsetMs = 9 * 60 * 60 * 1000;

/** `HH:MM` の 24 時間表記。検証（`timeValue`）を通った値を受け取る前提で分解する。 */
function parseTime(time: string): {
  readonly hour: number;
  readonly minute: number;
} {
  const [hour, minute] = time.split(':').map((part) => Number(part));
  return { hour: hour as number, minute: minute as number };
}

/** `Weekday` の略称から UTC 曜日番号（0=日 … 6=土）への対応。 */
const weekdayNumbers: Record<Weekday, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * 繰り返し定義から、`from` より後の直近の実行時刻を計算する。
 *
 * - `daily` は毎日 `HH:MM`。当日の指定時刻が `from` と同じか前なら翌日。
 * - `weekly` は指定曜日ごとの `HH:MM`。曜日の重複は検証で拒否済みだが、ここでは
 *   重複があっても最初に見つかった 1 つに畳む（同じ瞬間は 1 つしかない）。
 * - 常に「現在時刻より後」を返すため、再起動後に過去分を実行することはない（FR-12）。
 */
export function nextRunTime(repeat: Repeat, from: Date): Date {
  const { hour, minute } = parseTime(repeat.time);

  if (repeat.kind === 'daily') {
    const candidate = tokyoInstantFrom(from, 0, hour, minute);
    if (candidate.getTime() > from.getTime()) return candidate;
    return tokyoInstantFrom(from, 1, hour, minute);
  }

  // weekly: JST 曜日を基準に、from の JST 曜日から 7 日先まで順に探す。
  const wanted = new Set(repeat.days.map((day) => weekdayNumbers[day]));
  const tokyoWeekday = (date: Date): number => {
    // JST の 0 時基準の経過日から曜日を出す。1970-01-01（JST）は木曜（4）。
    const tokyoDay = Math.floor((date.getTime() + tokyoOffsetMs) / 86_400_000);
    return (((tokyoDay + 4) % 7) + 7) % 7;
  };
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = tokyoInstantFrom(from, offset, hour, minute);
    if (candidate.getTime() <= from.getTime()) continue;
    if (wanted.has(tokyoWeekday(candidate))) return candidate;
  }
  // `wanted` が空になることは検証で拒否済み。到達しないが、型上の安全網として
  // 「from + 7 日」を返す。
  return new Date(from.getTime() + 7 * 86_400_000);
}

/** `from` の JST 日付から `dayOffset` 日後の JST 日の `hour:minute` を UTC `Date` で返す。 */
function tokyoInstantFrom(
  from: Date,
  dayOffset: number,
  hour: number,
  minute: number,
): Date {
  const tokyoDay = Math.floor((from.getTime() + tokyoOffsetMs) / 86_400_000);
  const targetDay = tokyoDay + dayOffset;
  const dayStartUtcMs = targetDay * 86_400_000 - tokyoOffsetMs;
  return new Date(dayStartUtcMs + (hour * 60 + minute) * 60_000);
}

/**
 * 有効な予約すべての次回実行時刻を計算する。
 *
 * `enabled: false` の予約は対象外（FR-12）。戻り値は予約 ID → 次回時刻の写像。
 * 再読込時に新しい定義へ基づき全予約の次回時刻をこの関数で作り直す
 * （原子的差し替えの入力）。
 */
export function computeNextRuns(
  config: ManagedConfig,
  from: Date,
): ReadonlyMap<string, Date> {
  const next = new Map<string, Date>();
  for (const schedule of config.schedules) {
    if (!schedule.enabled) continue;
    next.set(schedule.id, nextRunTime(schedule.repeat, from));
  }
  return next;
}

/** スケジューラに渡す予約の実行計画。 */
export type SchedulePlan = {
  readonly schedule: Schedule;
  readonly nextRunAt: Date;
};

/**
 * 予約と次回時刻の組のリストを作る。
 *
 * `computeNextRuns` の写像から、定義順に（`schedules` の順序を維持して）
 * `Schedule` と `nextRunAt` を対応させる。スケジューラ本体はこの配列を状態として持ち、
 * 再読込時に丸ごと差し替える。
 */
export function createSchedulePlans(
  config: ManagedConfig,
  from: Date,
): readonly SchedulePlan[] {
  const nextRuns = computeNextRuns(config, from);
  const plans: SchedulePlan[] = [];
  for (const schedule of config.schedules) {
    const nextRunAt = nextRuns.get(schedule.id);
    if (nextRunAt === undefined) continue;
    plans.push({ schedule, nextRunAt });
  }
  return plans;
}

/**
 * 予約の対象を実行可能なサーバー集合へ確定する。
 *
 * 予約は「サーバー 1 台またはグループ 1 つ」である（FR-12）。グループは一括操作と
 * 同じ規則（`resolveBatchTargets`）でサーバー集合に確定する。対象が 0 台（未知の
 * グループ・空グループ）のときは空配列を返し、呼び出し側がスキップとして扱う。
 */
export function resolveScheduleTargets(
  schedule: Schedule,
  config: ManagedConfig,
): ReadonlyArray<OperableServer> {
  if (schedule.target.type === 'server') {
    const server = config.servers.find((s) => s.id === schedule.target.id);
    return server === undefined ? [] : [server];
  }
  // グループ対象は一括操作と同じ規則で確定する（FR-11 の対象確定を再利用）。
  return config.servers.filter(
    (server) =>
      schedule.target.type === 'group' &&
      server.groups.includes(schedule.target.id),
  );
}

/**
 * 予約実行器（j002〜j004, FR-12, NFR-12）。
 *
 * 1 秒間隔で「次回実行時刻を過ぎた予約」を探して発火する。実行は単体操作と同じ
 * `PowerOperator` を通すため、排他制御（busy 拒否）とリングバッファへの記録は
 * 手動操作と共有される。
 *
 * - `busy`: 対象が実行中なら待たずにスキップし、理由を結果へ残す（FR-12）。
 *   予約では待たない。複数台の対象は 1 台でも実行できなければ、その回を
 *   `busy` スキップとして扱う（部分実行は FR-12 の「1 予約 = 1 操作」に反する）。
 * - `missed_schedule`: 実行開始が指定時刻から 10 秒を超えたらその回をスキップし、
 *   ログに記録して次回時刻を再計算する（NFR-12）。プロセス停止・負荷・時刻の巻き戻り
 *   で「過去分をまとめて実行する」事故を防ぐ。
 * - 原子的差し替え: 再読込後は新しい定義から全予約の次回時刻を作り直し、
 *   実行中のティックの完了を待たずに状態を丸ごと差し替える（NFR-13）。
 *   差し替えは参照の置き換えだけであり、実行中の操作は中断しない。
 */
import { logScheduleSkip } from './power-log.server.ts';

/** 遅延スキップのしきい値（NFR-12）。指定時刻から 10 秒。 */
export const missedThresholdMs = 10_000;

/** ティック間隔（1 秒）。 */
const tickIntervalMs = 1_000;

/** 予約実行の結果を 1 件に畳む形。 */
export type ScheduleRunOutcome =
  | { readonly kind: 'ran'; readonly records: ReadonlyArray<unknown> }
  | { readonly kind: 'busy' }
  | { readonly kind: 'missed' };

/**
 * 予約実行器が依存する外部機能。
 *
 * `operator` は単体操作・一括操作と同じ実体を共有する（排他とリングバッファの共有）。
 * `now` はテストで時刻を固定するために注入する。`onRecord` は実行結果リングバッファ
 * （FR-13）とログ（NFR-10）への記録経路であり、スキップもこの経路で記録する（FR-12）。
 * `tickIntervalMs` はテストで短くするための差し替え口である。
 */
export type ScheduleRunnerDeps = {
  readonly operator: {
    readonly busyTargets: () => ReadonlySet<string>;
    readonly operateAll: (
      scope:
        | { readonly type: 'group'; readonly id: string }
        | { readonly type: 'all' },
      operation: 'wake' | 'shutdown',
      targets: ReadonlyArray<OperableServer>,
      runtime: {
        readonly sshIdentityFile: string;
        readonly sshKnownHostsFile: string;
      },
      options?: { readonly scheduleId?: string },
    ) => Promise<unknown>;
    readonly operate: (
      serverId: string,
      target: { readonly type: 'server'; readonly id: string },
      operation: 'wake' | 'shutdown',
      server: OperableServer,
      runtime: {
        readonly sshIdentityFile: string;
        readonly sshKnownHostsFile: string;
      },
      options?: { readonly scheduleId?: string },
    ) => Promise<unknown>;
  };
  readonly runtime: {
    readonly sshIdentityFile: string;
    readonly sshKnownHostsFile: string;
  };
  /** スキップを記録する経路。指定がなければ標準出力の 1 行 JSON へ出す。 */
  readonly onRecord?: (
    record: PowerOperationRecord,
    event: 'schedule_run' | 'schedule_skip',
  ) => void;
  readonly logSkip?: (
    scheduleId: string,
    code: 'busy' | 'missed_schedule' | 'invalid_configuration',
  ) => void;
  // テストが後から差し替えられるため readonly にしない。
  now?: () => Date;
  tickIntervalMs?: number;
};

/**
 * 1 回のティックで処理する 1 予約分の発火結果。
 *
 * 対象が確定できない予約（未定義のサーバー・未知のグループ）は設定不備であり、
 * `busy`（実行中）とは区別する（`docs/architecture.md` 6.5 の busy の定義）。
 */
export type TickResult = 'fired' | 'busy' | 'missed' | 'invalid_target';

/** deps から現在時刻を取り出す（テストの差し替えに追従する）。 */
function nowOf(deps: ScheduleRunnerDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

/**
 * スキップを記録する（FR-12, FR-13, NFR-10）。
 *
 * `onRecord` が指定されていれば実行結果と同じ経路（リングバッファ + 1 行 JSON ログ）へ
 * `schedule_skip` として流す。なければ従来どおり標準出力の専用ログへ出す。
 * 記録の失敗は予約の実行の成否に影響させない。
 */
function recordSkip(
  schedule: Schedule,
  deps: ScheduleRunnerDeps,
  code: 'busy' | 'missed_schedule' | 'invalid_configuration',
): void {
  if (deps.onRecord !== undefined) {
    const record: PowerOperationRecord = {
      at: nowOf(deps).toISOString(),
      scheduleId: schedule.id,
      target: schedule.target,
      operation: schedule.operation,
      result: 'skipped',
      code,
    };
    try {
      deps.onRecord(record, 'schedule_skip');
    } catch {
      // 記録の失敗は操作の成否に影響させない。
    }
    return;
  }
  const skipLogger =
    deps.logSkip ??
    ((id: string, c: 'busy' | 'missed_schedule' | 'invalid_configuration') =>
      logScheduleSkip(id, schedule.target, c));
  skipLogger(schedule.id, code);
}

/**
 * 予約 1 件の発火を判定・実行する（FR-12, NFR-12）。
 *
 * - 現在時刻（発火直前に `deps.now` から取り直す）が `nextRunAt` を過ぎていなければ
 *   何もしない（`undefined`）。直列実行や負荷で生じた実遅延もこの取り直しで判定する。
 * - 遅延が `missedThresholdMs`（10 秒）を超えていれば `missed`。実行せず記録する。
 * - 対象サーバーのうち 1 台でも `busyTargets()` に含まれていれば `busy`。
 *   待たずにスキップし、記録する。
 * - 対象が確定できない（0 台・未知の対象）予約は `invalid_target`。実行せず
 *   `invalid_configuration` として記録する。
 * - 対象が 1 台なら `operate`、複数台なら `operateAll` を使う。どちらも
 *   `scheduleId` を結果へ運ぶ（FR-13 の「予約」表示）。
 *
 * この関数は reject しない。実行単位の例外は操作の失敗として扱い、ティックから
 * 投げてプロセスを落とさない（NFR-12 の継続性）。
 */
export async function fireSchedule(
  plan: SchedulePlan,
  config: ManagedConfig,
  deps: ScheduleRunnerDeps,
): Promise<TickResult | undefined> {
  const now = nowOf(deps);
  if (plan.nextRunAt.getTime() > now.getTime()) return undefined;
  const delayMs = now.getTime() - plan.nextRunAt.getTime();

  if (delayMs > missedThresholdMs) {
    recordSkip(plan.schedule, deps, 'missed_schedule');
    return 'missed';
  }

  const targets = resolveScheduleTargets(plan.schedule, config);
  if (targets.length === 0) {
    // 対象が確定できない予約（未定義の対象）は設定不備であり、busy とは区別する。
    recordSkip(plan.schedule, deps, 'invalid_configuration');
    return 'invalid_target';
  }

  const busy = deps.operator.busyTargets();
  if (targets.some((t) => busy.has(t.id))) {
    recordSkip(plan.schedule, deps, 'busy');
    return 'busy';
  }

  const scheduleId = plan.schedule.id;
  if (targets.length === 1) {
    const server = targets[0] as OperableServer;
    try {
      await deps.operator.operate(
        server.id,
        { type: 'server', id: server.id },
        plan.schedule.operation,
        server,
        deps.runtime,
        { scheduleId },
      );
    } catch {
      // 実行単位の例外は操作の失敗として扱う。実行器の内部の詳細はログに載せない
      // （SEC-05）。operator は通常 reject を結果に畳むため、ここは安全網である。
    }
  } else {
    try {
      await deps.operator.operateAll(
        { type: 'group', id: plan.schedule.target.id },
        plan.schedule.operation,
        targets,
        deps.runtime,
        { scheduleId },
      );
    } catch {
      // 同上。
    }
  }
  return 'fired';
}

/**
 * プロセス共有の予約実行器（j002）。
 *
 * モジュールスコープのシングルトンとし、二重起動を防ぐ。`NODE_ENV !== production`
 * では起動しない（テストや開発の過程で予約が動くと操作を取り違えるため）。
 *
 * 状態（予約と次回時刻の計画）は 1 つのオブジェクトにまとめ、参照の差し替えだけで
 * 原子的に更新する（j004）。実行中の発火は新旧どちらの計画にも依らず完了する。
 */
export type ScheduleRunner = {
  /** スケジューラを始動する。すでに動いている場合は何もしない。 */
  start(): void;
  /**
   * スケジューラを停止する。テストと終了処理のため。
   *
   * 実行中のティックの完了を待ってから解決する（進行中の発火を置き去りにしない）。
   */
  stop(): Promise<void>;
  /** 動作中かどうか。テスト用。 */
  isRunning(): boolean;
  /** 計画を原子的に差し替える（j004）。再読込時に呼ぶ。 */
  replacePlans(config: ManagedConfig): void;
  /** 現在の計画。テスト用。 */
  plans(): readonly SchedulePlan[];
};

/**
 * 予約の「本日の実行時刻」が既に過ぎているならその時刻を、そうでなければ `null` を返す。
 *
 * 初回ロード・再読込では、次回時刻は常に現在より後に計算されるため、本日の分は
 * 実行されない（FR-12）。その事実を黙って捨てず、スキップとして記録するための判定。
 * weekly は本日が指定曜日のときだけ本日の分を持つ。
 */
function passedTodayRun(repeat: Repeat, now: Date): Date | null {
  const { hour, minute } = parseTime(repeat.time);
  const tokyoDay = Math.floor((now.getTime() + tokyoOffsetMs) / 86_400_000);
  const instant = new Date(
    tokyoDay * 86_400_000 - tokyoOffsetMs + (hour * 60 + minute) * 60_000,
  );
  if (instant.getTime() > now.getTime()) return null;
  if (repeat.kind === 'daily') return instant;
  const weekday = (((tokyoDay + 4) % 7) + 7) % 7;
  const wanted = repeat.days.some((day) => weekdayNumbers[day] === weekday);
  return wanted ? instant : null;
}

/** 作成済みの共有実行器。モジュールスコープで 1 つだけ。 */
let sharedRunner: ScheduleRunner | null = null;

/**
 * 予約実行器を作る（または共有インスタンスを返す）。
 *
 * 実運用は `getScheduleRunner()` を通して唯一の実体を使う。テストは
 * `createScheduleRunner` を直接呼んで独立インスタンスを作れる。
 */
export function createScheduleRunner(
  initialConfig: ManagedConfig,
  deps: ScheduleRunnerDeps,
): ScheduleRunner {
  // 計画は 1 つのオブジェクトに束ね、参照の差し替えだけで原子的に更新する。
  // deps.now はテストで後から差し替えられるため、毎回参照する。
  const nowFn = (): Date => (deps.now ?? (() => new Date()))();

  /**
   * 計画を作る。
   *
   * 本日の実行時刻が既に過ぎている有効な予約は、この後のティックでも実行されない
   * （次回時刻は常に現在より後になる）。その事実をスキップとして記録する（FR-12）。
   */
  const buildState = (config: ManagedConfig) => {
    const now = nowFn();
    for (const schedule of config.schedules) {
      if (!schedule.enabled) continue;
      if (passedTodayRun(schedule.repeat, now) !== null) {
        recordSkip(schedule, deps, 'missed_schedule');
      }
    }
    return { plans: createSchedulePlans(config, now), config };
  };

  let state: {
    readonly plans: readonly SchedulePlan[];
    readonly config: ManagedConfig;
  } = buildState(initialConfig);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  /** 実行中のティックの数。`stop()` の完了待ちに使う。 */
  let inFlight = 0;
  /** `stop()` の完了待ちを解決する。実行中のティックがなければ即座に解決する。 */
  let quiesced: (() => void) | null = null;

  const tick = async (): Promise<void> => {
    inFlight += 1;
    try {
      const now = nowFn();
      // 差し替え安全のために、このティックで扱う計画を最初に取り出す（スナップショット）。
      const current = state;
      const due = current.plans.filter(
        (plan) => plan.nextRunAt.getTime() <= now.getTime(),
      );
      if (due.length === 0) return;
      // 期限到来分の次回時刻を、発火の前にまとめて前進させる。発火の成否・例外に
      // 依らず前進するため、1 件目の発火が例外でも 2 件目以降の前進が落ちない。
      // また発火前に前進するため、直列実行や長い発火の間に同じ回が二重発火しない。
      if (state === current) {
        const dueIds = new Set(due.map((plan) => plan.schedule.id));
        state = {
          ...current,
          plans: current.plans.map((plan) =>
            dueIds.has(plan.schedule.id)
              ? { ...plan, nextRunAt: nextRunTime(plan.schedule.repeat, now) }
              : plan,
          ),
        };
      }
      // 発火は並行に行う（NFR-12）。1 件の長い操作（SSH 停止は最大 30 秒）が他の
      // 予約を遅らせない。fireSchedule は reject しないため例外は漏れない。
      await Promise.all(
        due.map((plan) => fireSchedule(plan, current.config, deps)),
      );
    } catch (error) {
      // ティック自体の失敗（deps の実装の不具合など）を記録して継続する。
      // `setInterval` のコールバックは reject を捨てるため、ここで受け止める。
      console.error(
        JSON.stringify({
          event: 'schedule_run',
          result: 'failed',
          code: 'operation_failed',
          reason: String(error).slice(0, 200),
        }),
      );
    } finally {
      inFlight -= 1;
      if (inFlight === 0 && quiesced !== null) {
        const resolve = quiesced;
        quiesced = null;
        resolve();
      }
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      // unref しない。プロセスはスケジューラで生き続ける意図である。
      timer = setInterval(() => {
        void tick();
      }, deps.tickIntervalMs ?? tickIntervalMs);
    },
    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      running = false;
      if (inFlight === 0) return;
      await new Promise<void>((resolve) => {
        quiesced = resolve;
      });
    },
    isRunning() {
      return running;
    },
    replacePlans(config: ManagedConfig) {
      // 原子的差し替え（j004）。実行中の発火は参照をスナップショット済みであり、
      // 中断しない。差し替え後のティックから新しい計画で動く。
      state = buildState(config);
    },
    plans() {
      return state.plans;
    },
  };
}

/**
 * プロセス共有の予約実行器を取得する（存在しなければ作る）。
 *
 * モジュールスコープのシングルトン。二重起動（start の二重呼び出し）は
 * `start` 内の `running` 判定で防ぐ。
 */
export function getScheduleRunner(
  initialConfig: ManagedConfig,
  deps: ScheduleRunnerDeps,
): ScheduleRunner {
  if (sharedRunner === null)
    sharedRunner = createScheduleRunner(initialConfig, deps);
  return sharedRunner;
}
