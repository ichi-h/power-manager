/**
 * 設定画面（FR-08, FR-09, NFR-13）。
 *
 * 次の 2 つだけを担う。
 *
 * - 現在の有効な管理対象定義（サーバー・グループ・予約）を読み取り専用で表示する。
 *   画面からの追加・変更・削除は提供しない（CON-09）。
 * - `intent=reload` の action で定義を再読込し、結果種別だけをその場に表示する。
 *
 * 再読込の成否の扱いは `docs/operations.md` 2.4 に従う。失敗しても旧設定を維持し、
 * 画面には結果種別しか出さない（FR-07）。失敗理由は `config_reload` の 1 行ログにだけ
 * 残す（SEC-05）。操作は画面遷移を起こさない（FR-14）ため、`fetcher.submit` を使う。
 */
import { useFetcher } from 'react-router';

import type { Route } from './+types/settings';
import { requireRuntimeConfig } from '../lib/config.server.ts';
import { requireConfigStore } from '../lib/config-store.server.ts';
import type { ManagedConfig, Repeat } from '../lib/model.ts';
import { logConfigReload } from '../lib/power-log.server.ts';
import { requireScheduleRunner } from '../lib/schedule-runner-context.server.ts';

export function meta(_args: Route.MetaArgs) {
  return [{ title: '設定 - power-manager' }];
}

/**
 * 画面へ渡すデータ。
 *
 * `ManagedConfig` をそのまま渡さず、画面に出す項目だけを写す。停止コマンドなどの
 * 「画面に出す必要のない設定値」を loader の応答（`.data` 要求のペイロード）へ
 * 含めないためである（SEC-05）。
 */
export type SettingsLoaderData = {
  readonly configPath: string;
  readonly servers: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly groups: ReadonlyArray<string>;
    readonly host: string;
    readonly port: number;
    readonly macAddress: string;
    readonly broadcastAddress: string;
    readonly wolPort: number;
  }>;
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
  }>;
  readonly schedules: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly operation: string;
    readonly target: string;
    readonly repeat: string;
  }>;
};

/**
 * 設定画面の loader。
 *
 * 認証は root のミドルウェアが要求する（FR-10, SEC-01）。定義は再読込のたびに
 * 差し替わるため、キャッシュを許さない応答にしておく。
 */
export function loader({ context }: Route.LoaderArgs): SettingsLoaderData {
  const config = requireConfigStore(context).current();

  return {
    configPath: requireConfigPath(context),
    ...toSettingsRows(config),
  };
}

/** action が返す結果。画面に出すのは結果種別だけである（FR-07）。 */
export type ReloadPayload =
  | { readonly result: 'succeeded'; readonly schedules: number | null }
  | { readonly result: 'failed' };

/** 応答が `ReloadPayload` の形かどうか（想定外の応答では表示を変えない）。 */
export function isReloadPayload(value: unknown): value is ReloadPayload {
  if (typeof value !== 'object' || value === null) return false;
  const result = (value as Partial<ReloadPayload>).result;
  return result === 'succeeded' || result === 'failed';
}

/**
 * 定義の再読込の action（FR-08, NFR-13）。
 *
 * 1. 設定ストアの `reload()` で読み込み・全体検証・差し替えを行う。検証に失敗した
 *    場合は旧設定が維持される（`app/lib/config-store.server.ts`）。
 * 2. 成功したら、新しい定義で予約の次回実行時刻を再計算してスケジューラの状態を
 *    原子的に差し替える。差し替えは実行中の操作を中断しない。予約実行器が無い
 *    （production 以外）ときは何もしない。
 * 3. 成否を `config_reload` の 1 行ログに残す。失敗理由はログにだけ出す。
 *
 * 応答は常に 200 で返し、結果種別だけを載せる。再読込の失敗はエラーバウンダリではなく
 * 画面の結果表示に載る対象だからである（`docs/architecture.md` 3 章, FR-07）。
 *
 * なお手順 1 と 2 の間で定義が変わらないのは、設定ストアの差し替えと予約実行器の
 * 差し替えが同じ関数内で連続して行われ、その間に他の再読込が割り込まないためである
 * （`reload()` は到着順に直列化される）。
 */
export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get('intent') !== 'reload') return invalidRequest();

  const store = requireConfigStore(context);

  let outcome: ReloadResultLike;
  try {
    outcome = await store.reload();
  } catch (error) {
    // `reload()` は失敗を値で返す契約だが、実装の不具合で例外になった場合も
    // 画面をエラーバウンダリにせず、失敗として扱う（FR-07）。
    logConfigReload('failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ result: 'failed' } satisfies ReloadPayload);
  }

  if (!outcome.ok) {
    logConfigReload('failed', { reason: outcome.reason });
    return jsonResponse({ result: 'failed' } satisfies ReloadPayload);
  }

  // 成功時のみスケジューラを差し替える。実行中の発火は中断しない（NFR-13）。
  const runner = requireScheduleRunner(context);
  let schedules: number | null = null;
  if (runner !== null) {
    runner.replacePlans(outcome.config);
    schedules = runner.plans().length;
  }

  logConfigReload('succeeded', {
    ...(schedules === null ? {} : { schedules }),
  });

  return jsonResponse({
    result: 'succeeded',
    schedules,
  } satisfies ReloadPayload);
}

/**
 * `ConfigStore.reload()` の戻り値のうち action が読む部分。
 *
 * server-only の型を client 側へ引き込まないよう、必要な形だけを写す。
 */
type ReloadResultLike =
  | { readonly ok: true; readonly config: ManagedConfig }
  | { readonly ok: false; readonly reason: string };

/** JSON 応答を組み立てる。画面の fetcher は常に JSON を受ける。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 結果は要求ごとの一時的な値であり、キャッシュさせない。
      'cache-control': 'no-store',
    },
  });
}

/** 未知の intent・intent 無しの要求。再読込は行わない。 */
function invalidRequest(): Response {
  return new Response(JSON.stringify({ error: 'invalid_request' }), {
    status: 400,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * 定義ファイルのパスを読む（表示用）。
 *
 * `configPath` は秘密ではないが、環境変数の生値は load context に秘密値ごと載せない
 * 方針のため、公開値（`PublicRuntimeConfig`）から取る。
 */
/** 公開実行時設定から定義ファイルのパスを読む（表示用）。 */
function requireConfigPath(context: Route.LoaderArgs['context']): string {
  return requireRuntimeConfig(context).configPath;
}

/** 公開実行時設定を読む。 */
/** 定義から画面用の行データを作る。定義順をそのまま保つ（FR-01）。 */
function toSettingsRows(
  config: ManagedConfig,
): Omit<SettingsLoaderData, 'configPath'> {
  const groupNames = new Map(
    config.groups.map((group) => [group.id, group.name]),
  );

  return {
    servers: config.servers.map((server) => ({
      id: server.id,
      name: server.name,
      groups: server.groups.map(
        (groupId) => groupNames.get(groupId) ?? groupId,
      ),
      host: server.ssh.host,
      port: server.ssh.port,
      macAddress: server.macAddress,
      broadcastAddress: server.wol.broadcastAddress,
      wolPort: server.wol.port,
    })),
    groups: config.groups.map((group) => ({
      id: group.id,
      name: group.name,
    })),
    schedules: config.schedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      operation: operationLabels[schedule.operation],
      target: describeTarget(schedule.target, groupNames),
      repeat: describeRepeat(schedule.repeat),
    })),
  };
}

/** 予約の対象を「サーバー NAS」「グループ ストレージ」の形にする。 */
function describeTarget(
  target: ManagedConfig['schedules'][number]['target'],
  groupNames: ReadonlyMap<string, string>,
): string {
  if (target.type === 'server') return `サーバー ${target.id}`;
  return `グループ ${groupNames.get(target.id) ?? target.id}`;
}

/** 操作の表示文言。 */
const operationLabels = {
  wake: '起動',
  shutdown: '停止',
} as const;

/** 予約の繰り返しを「毎日 23:30」「毎週 月・水 07:00」の形にする。 */
function describeRepeat(repeat: Repeat): string {
  if (repeat.kind === 'daily') return `毎日 ${repeat.time}`;
  const days = repeat.days.map((day) => weekdayLabels[day]).join('・');
  return `毎週 ${days} ${repeat.time}`;
}

/** 曜日の表示文言。 */
const weekdayLabels = {
  mon: '月',
  tue: '火',
  wed: '水',
  thu: '木',
  fri: '金',
  sat: '土',
  sun: '日',
} as const;

/**
 * 再読込のボタンと結果表示（FR-07, FR-08）。
 *
 * `fetcher.state` が `idle` でない間は「再読込中」、完了後は結果種別だけを出す。
 * 失敗理由は画面に出さない（ログにだけ残す）。
 */
function ReloadControls() {
  const fetcher = useFetcher<unknown>();
  const running = fetcher.state !== 'idle';
  const payload = isReloadPayload(fetcher.data) ? fetcher.data : null;

  return (
    <div>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="reload" />
        <button type="submit" disabled={running}>
          定義を再読込
        </button>
      </fetcher.Form>
      {running ? <span role="status">再読込中</span> : null}
      {running || payload === null ? null : payload.result === 'succeeded' ? (
        <span role="status">
          再読込: 成功
          {payload.schedules === null ? null : (
            <>（予約 {payload.schedules} 件を再計算）</>
          )}
        </span>
      ) : (
        <span role="status">再読込: 失敗</span>
      )}
    </div>
  );
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  return (
    <section>
      <h2>設定</h2>
      <p>
        定義ファイル: <code>{loaderData.configPath}</code>
      </p>
      <p>
        定義はこの画面からは変更できません。ファイルを編集してから再読込してください。
      </p>
      <ReloadControls />

      <h3>サーバー</h3>
      {loaderData.servers.length === 0 ? (
        <p>サーバーが登録されていません。</p>
      ) : (
        <ul>
          {loaderData.servers.map((server) => (
            <li key={server.id}>
              <span>{server.name}</span>
              <span>ID: {server.id}</span>
              <span>
                所属グループ:{' '}
                {server.groups.length === 0 ? 'なし' : server.groups.join('、')}
              </span>
              <span>
                接続先: {server.host}:{server.port}
              </span>
              <span>MAC アドレス: {server.macAddress}</span>
              <span>
                WOL: {server.broadcastAddress}:{server.wolPort}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>グループ</h3>
      {loaderData.groups.length === 0 ? (
        <p>グループが登録されていません。</p>
      ) : (
        <ul>
          {loaderData.groups.map((group) => (
            <li key={group.id}>
              <span>{group.name}</span>
              <span>ID: {group.id}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>予約</h3>
      {loaderData.schedules.length === 0 ? (
        <p>予約が登録されていません。</p>
      ) : (
        <ul>
          {loaderData.schedules.map((schedule) => (
            <li key={schedule.id}>
              <span>{schedule.name}</span>
              <span>ID: {schedule.id}</span>
              <span>{schedule.enabled ? '有効' : '無効'}</span>
              <span>対象: {schedule.target}</span>
              <span>操作: {schedule.operation}</span>
              <span>{schedule.repeat}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
