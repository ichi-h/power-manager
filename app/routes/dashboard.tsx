/**
 * 一覧画面（FR-01, FR-02, FR-05, FR-07, FR-13, FR-14, NFR-09）。
 *
 * 1 画面に次を出す。
 *
 * - 全サーバーの行（表示名・所属グループ・死活状態・単体の起動/停止ボタン）
 * - サーバーが属するグループの一覧（t009 でグループ一括ボタンを足す土台）
 * - 「最近の実行」欄（直近 100 件）
 *
 * 状態の初期値は loader で取得する（FR-01）。以降は 15 秒ごとに
 * `fetcher.load("/api/status")` で状態だけを更新する（FR-02）。単体操作は
 * `fetcher.submit` で action を呼び、`fetcher.state` / `fetcher.data` をその行に出す
 * （FR-07）。ページ全体の再読み込みも URL の変更も起こさない（FR-14）。
 */
import { useEffect, useRef, useState } from 'react';
import { useFetcher, type RouterContext } from 'react-router';

import type { Route } from './+types/dashboard';
import { requireConfigStore } from '../lib/config-store.server.ts';
import { requireHistory } from '../lib/history.server.ts';
import type {
  ManagedConfig,
  PowerOperation,
  ServerState,
} from '../lib/model.ts';
import { operatorContext } from '../lib/operator-context.server.ts';
import type {
  PowerOperator,
  PowerOperationRecord,
} from '../lib/power.server.ts';
import { requireSshRuntime } from '../lib/ssh-runtime-context.server.ts';
import {
  requireStatusChecker,
  type StatusResponse,
} from '../lib/status-checker-context.ts';

/** 状態の自動更新の間隔（FR-02）。15 秒固定で、外部から変える設定項目は持たない。 */
export const statusRefreshIntervalMs = 15_000;

export function meta(_args: Route.MetaArgs) {
  return [{ title: 'power-manager' }];
}

/**
 * loader が画面へ渡すデータ。
 *
 * `groups` はサーバーが持つ所属グループ ID を、定義の順序で重複を除いて並べたもの。
 * 各サーバーの行に出す所属グループの表示名は、`groups` の ID から `config.groups` を
 * 引いて解決する。
 */
export type DashboardLoaderData = {
  readonly servers: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly groups: ReadonlyArray<string>;
  }>;
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
  }>;
  readonly states: Readonly<Record<string, ServerState>>;
  readonly recent: ReadonlyArray<PowerOperationRecord>;
};

/**
 * 一覧画面の loader。
 *
 * 認証は root のミドルウェアが要求する（FR-10, SEC-01, `docs/security.md` 2.2）。
 * それでも loader を必ずエクスポートするのは、クライアントサイド遷移でサーバー要求を
 * 発生させるためである（loader が無いと `.data` 要求が起きず、ミドルウェアが走らない）。
 *
 * 死活状態の初期取得は「状態表示が `unknown` のまま残る時間」を短くするため loader で
 * 行う（FR-01）。取得は 5 秒上限・同時 8 の確認器を通すため、上限は NFR-07 に収まる。
 */
export async function loader({
  context,
}: Route.LoaderArgs): Promise<DashboardLoaderData> {
  const config = requireConfigStore(context).current();
  const checker = requireStatusChecker(context);
  const states = await checker.checkAll(config.servers);

  return {
    ...toServerRows(config),
    states: Object.fromEntries(
      config.servers.map((server) => [
        server.id,
        states.get(server.id) ?? 'unknown',
      ]),
    ),
    recent: requireHistory(context).recent(),
  };
}

/** 定義から画面用の行データを作る。設定順序をそのまま保つ（FR-01）。 */
function toServerRows(
  config: ManagedConfig,
): Pick<DashboardLoaderData, 'servers' | 'groups'> {
  return {
    servers: config.servers.map((server) => ({
      id: server.id,
      name: server.name,
      groups: server.groups,
    })),
    groups: config.groups.map((group) => ({ id: group.id, name: group.name })),
  };
}

/**
 * action が返す結果。画面に出すのは種別と対象だけである（FR-07）。
 *
 * コマンド内容・認証情報・鍵情報・内部エラーの詳細は含めない（SEC-05）。
 */
export type OperationResultKind =
  | 'succeeded'
  | 'failed'
  /** 実行中のため拒否した（`busy`）。 */
  | 'rejected'
  /** 一括操作で実行中の対象を飛ばした（`skipped`）。 */
  | 'skipped';

export type OperationResult = {
  readonly target: string;
  readonly operation: PowerOperation;
  readonly result: OperationResultKind;
};

/**
 * 画面に出す結果種別への畳み込み。
 *
 * `busy` は「実行中なので拒否した」を表す。単体操作の操作器は `skipped` + `busy` を返し、
 * 一括操作や予約の `skipped` は「対象を飛ばした」を表す。分類（`code`）が `busy` のときだけ
 * 「実行中（拒否）」とし、それ以外の `skipped` は「スキップ」と出し分ける（FR-07, FR-11）。
 */
export function toResultKind(record: {
  readonly result: PowerOperationRecord['result'];
  readonly code: PowerOperationRecord['code'];
}): OperationResultKind {
  if (record.result === 'succeeded') return 'succeeded';
  // 単体操作の busy は操作器が `{ result: 'skipped', code: 'busy' }` を返す
  // (`app/routes/dashboard.tsx` の action が受ける `PowerOperationRecord`)。`skipped` は
  // 一括操作で実行中の対象を飛ばした意味であり、単体操作の拒否とは表示区分が違うため、
  // `code === 'busy'` を `result === 'skipped'` より先に判定する (FR-07)。
  if (record.code === 'busy') return 'rejected';
  if (record.result === 'skipped') return 'skipped';
  return 'failed';
}

/**
 * 単体操作の action（FR-04, FR-05, FR-07）。
 *
 * `intent=wake` / `intent=shutdown` と `target`（サーバー ID）を受ける。対象が定義に無い
 * 場合は `400` を返す（画面には結果を出さない）。結果は対象 ID と種別だけを返し、
 * `fetcher.data` としてその行に表示する。
 *
 * スクリプト無効時のフォーム送信（`303` で一覧へ戻る PRG）は別チケット（t012）の領分で
 * あり、ここでは fetcher 向けの JSON 応答だけを扱う。
 */
export async function action({ request, context }: Route.ActionArgs) {
  const config = requireConfigStore(context).current();
  const form = await request.formData();
  const intent = form.get('intent');
  const target = form.get('target');

  if (intent !== 'wake' && intent !== 'shutdown') return badRequest();
  if (typeof target !== 'string') return badRequest();

  const server = config.servers.find((candidate) => candidate.id === target);
  if (server === undefined) return badRequest();

  const record = await requireOperator(context).operate(
    server.id,
    { type: 'server', id: server.id },
    intent,
    server,
    requireSshRuntime(context),
  );

  const body: OperationResult = {
    target: server.id,
    operation: intent,
    result: toResultKind(record),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** 対象・種別が不正な要求。定義に無いサーバー ID もここに落とす。 */
function badRequest(): Response {
  return new Response(JSON.stringify({ error: 'invalid_request' }), {
    status: 400,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** 電源操作器を load context から読む。 */
function requireOperator(context: RouterContextProviderLike): PowerOperator {
  try {
    return context.get(operatorContext);
  } catch (cause) {
    throw new Error(
      '電源操作器が load context にありません（server/app.ts の createLoadContext を経由していません）',
      { cause },
    );
  }
}

/** `RouterContextProvider` のうち action が使う部分。 */
type RouterContextProviderLike = { get: <T>(key: RouterContext<T>) => T };

/** 状態の表示文言（FR-03）。 */
const stateLabels: Record<ServerState, string> = {
  online: 'オンライン',
  offline: 'オフライン',
  unknown: '未取得',
};

/** 結果の表示文言（FR-07）。種別と対象だけを出し、内部の理由は出さない。 */
const resultLabels: Record<OperationResultKind, string> = {
  succeeded: '成功',
  failed: '失敗',
  rejected: '実行中（拒否）',
  skipped: 'スキップ',
};

/** 操作の表示文言。 */
const operationLabels: Record<PowerOperation, string> = {
  wake: '起動',
  shutdown: '停止',
};

/** 状態取得のリソースルートのパス（FR-02）。 */
const statusPath = '/api/status';

/**
 * 15 秒ごとに状態だけを更新する（FR-02）。
 *
 * - `useRevalidator` は使わない。ページの loader を再実行すると「最近の実行」欄まで
 *   取り直すことになり、状態表示の領域だけを差し替える要件に反する。
 * - `document.visibilityState` が `hidden` の間はタイマーを止め、`visible` に戻った時点で
 *   即座に 1 回読み込む（タブ非表示中の無駄な確認を止める）。
 * - 4xx/5xx・ネットワーク失敗では表示を変えず、次周期で再試行する。
 *
 * 状態はサーバーの初期値（`initialStates`）を起点に、取得できた分だけ差し替える。
 */
export function useStatusAutoRefresh(
  initialStates: Readonly<Record<string, ServerState>>,
  fetcher: { load: (href: string) => void; data?: unknown; state: string },
): Readonly<Record<string, ServerState>> {
  const [states, setStates] = useState(initialStates);
  const lastData = useRef<unknown>(undefined);

  // 毎周期の `fetcher.load` は同じインスタンスを使う。レンダーごとに関数を差し替えない
  // よう、ref 経由で最新の fetcher を参照する。
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (fetcher.data === undefined || fetcher.data === lastData.current) return;
    lastData.current = fetcher.data;
    const next = parseStatusResponse(fetcher.data);
    if (next !== null) setStates((previous) => ({ ...previous, ...next }));
  }, [fetcher.data]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = () => {
      fetcherRef.current.load(statusPath);
    };

    const start = () => {
      if (timer !== undefined) return;
      // 表示に戻った時点で即座に 1 回確認する（最大 15 秒の空白を作らない）。
      tick();
      timer = setInterval(tick, statusRefreshIntervalMs);
    };

    const stop = () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return states;
}

/**
 * `/api/status` の応答を検証する。
 *
 * 想定外の形（リバースプロキシのエラーページ等）では `null` を返し、表示を変えない。
 * 状態として解釈できない値も捨てる。
 */
export function parseStatusResponse(
  value: unknown,
): Record<string, ServerState> | null {
  if (typeof value !== 'object' || value === null) return null;
  const states = (value as Partial<StatusResponse>).states;
  if (typeof states !== 'object' || states === null) return null;

  const parsed: Record<string, ServerState> = {};
  for (const [serverId, state] of Object.entries(states)) {
    if (state === 'online' || state === 'offline' || state === 'unknown') {
      parsed[serverId] = state;
    }
  }
  return parsed;
}

/** 1 行の操作ボタン。停止は確認ダイアログを出し、拒否時は送信しない（FR-05, SEC-07）。 */
function OperationButton({
  server,
  operation,
  fetcher,
  disabled = false,
}: {
  server: DashboardLoaderData['servers'][number];
  operation: PowerOperation;
  fetcher: { submit: (target: HTMLFormElement) => void };
  disabled?: boolean;
}) {
  return (
    <form
      method="post"
      onSubmit={(event) => {
        // 予約による停止は人間の確認を挟まない（`docs/security.md` 3.3）。この確認は
        // 「画面から人が押したとき」にだけ効く位置にあり、action や予約経路には入らない。
        if (
          operation === 'shutdown' &&
          !window.confirm(`${server.name} を停止しますか`)
        ) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        fetcher.submit(event.currentTarget);
      }}
    >
      <input type="hidden" name="intent" value={operation} />
      <input type="hidden" name="target" value={server.id} />
      {/* 進行中は同じ行の 2 つのボタンを閉じ、二重送信と結果の上書きを防ぐ（FR-07）。 */}
      <button type="submit" disabled={disabled}>
        {operationLabels[operation]}
      </button>
    </form>
  );
}

/**
 * 行内の進行表示と結果表示（FR-07）。
 *
 * `fetcher.state` が `submitting`/`loading` の間は「実行中」、完了後は結果種別を出す。
 * URL もページ全体も変えない（FR-14）。
 */
function ServerRow({
  server,
  groupNames,
  state,
}: {
  server: DashboardLoaderData['servers'][number];
  groupNames: ReadonlyArray<string>;
  state: ServerState;
}) {
  const wakeFetcher = useFetcher<OperationResult>();
  const shutdownFetcher = useFetcher<OperationResult>();

  const running =
    wakeFetcher.state !== 'idle' || shutdownFetcher.state !== 'idle';

  // 行に出す結果は「最後に完了した操作」だけにする。2 つの fetcher を固定の順序で
  // 優先すると、後から完了した操作の結果が隠れる（起動成功の後の停止失敗など）。
  // 完了のたびに結果と送信連番を記録し、連番の大きいほうを採る（FR-07）。
  const [latest, setLatest] = useState<{
    readonly result: OperationResult;
    readonly submittedAt: number;
  }>();
  const submitCount = useRef(0);
  const seen = useRef<
    Partial<Record<PowerOperation, { data: OperationResult; count: number }>>
  >({});

  useEffect(() => {
    for (const [operation, fetcher] of [
      ['wake', wakeFetcher],
      ['shutdown', shutdownFetcher],
    ] as const) {
      if (fetcher.state !== 'idle' || fetcher.data === undefined) continue;
      const previous = seen.current[operation];
      // 同じ応答を繰り返し処理しない（再レンダーで送信連番を取り直さない）。
      if (previous?.data === fetcher.data) continue;
      submitCount.current += 1;
      const entry = { data: fetcher.data, count: submitCount.current };
      seen.current[operation] = entry;
      setLatest((current) =>
        current === undefined || entry.count > current.submittedAt
          ? { result: fetcher.data!, submittedAt: entry.count }
          : current,
      );
    }
  }, [wakeFetcher.state, wakeFetcher.data, shutdownFetcher.state, shutdownFetcher.data]);

  return (
    <li>
      <span>{server.name}</span>
      <span>
        所属グループ: {groupNames.length === 0 ? 'なし' : groupNames.join('、')}
      </span>
      <span>状態: {stateLabels[state]}</span>
      <OperationButton
        server={server}
        operation="wake"
        fetcher={wakeFetcher}
        disabled={running}
      />
      <OperationButton
        server={server}
        operation="shutdown"
        fetcher={shutdownFetcher}
        disabled={running}
      />
      {running ? <span role="status">実行中</span> : null}
      {running || latest === undefined ? null : (
        <span role="status">
          {operationLabels[latest.result.operation]}:{' '}
          {resultLabels[latest.result.result]}
        </span>
      )}
    </li>
  );
}

/** 「最近の実行」の 1 行（FR-13）。表示は実行時刻・予約 ID・対象・操作・結果・理由に限る。 */
function RecentRow({ record }: { record: PowerOperationRecord }) {
  return (
    <li>
      <time dateTime={record.at}>{record.at}</time>
      <span>予約: {record.scheduleId ?? 'なし'}</span>
      <span>
        対象: {record.target.type === 'server' ? 'サーバー' : 'グループ'}{' '}
        {record.target.id}
      </span>
      <span>操作: {operationLabels[record.operation]}</span>
      <span>結果: {resultLabels[toResultKind(record)]}</span>
      <span>理由: {record.code ?? 'なし'}</span>
    </li>
  );
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const statusFetcher = useFetcher<StatusResponse>();
  const states = useStatusAutoRefresh(loaderData.states, statusFetcher);
  const groupNames = new Map(
    loaderData.groups.map((group) => [group.id, group.name]),
  );

  return (
    <section>
      <h2>サーバー一覧</h2>
      {loaderData.servers.length === 0 ? (
        <p>サーバーが登録されていません。</p>
      ) : (
        <ul>
          {loaderData.servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              state={states[server.id] ?? 'unknown'}
              groupNames={server.groups.map(
                (groupId) => groupNames.get(groupId) ?? groupId,
              )}
            />
          ))}
        </ul>
      )}
      <h2>最近の実行</h2>
      {loaderData.recent.length === 0 ? (
        <p>まだ実行はありません。</p>
      ) : (
        <ul>
          {loaderData.recent.map((record) => (
            <RecentRow
              key={`${record.at}:${record.target.type}:${record.target.id}`}
              record={record}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
