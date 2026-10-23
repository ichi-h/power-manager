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
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useFetcher, type RouterContext } from 'react-router';

import type { Route } from './+types/dashboard';
import { requireConfigStore } from '../lib/config-store.server.ts';
import { isFormSubmission, seeOther } from '../lib/form-submission.server.ts';
import type { HistoryRecord, HistoryResponse } from '../lib/history-context.ts';
import { requireHistory } from '../lib/history.server.ts';
import type {
  ManagedConfig,
  PowerOperation,
  ServerState,
} from '../lib/model.ts';
import { operatorContext } from '../lib/operator-context.server.ts';
import {
  resolveBatchTargets,
  type BatchOperationScope,
  type PowerOperationCode,
  type PowerOperator,
  type PowerOperationRecord,
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
  readonly recent: ReadonlyArray<HistoryRecord>;
  /**
   * 通常フォーム送信（スクリプト無効時）の結果表示（NFR-09）。
   *
   * クエリから組み立てた表示専用の値であり、`null` なら何も出さない。ここから
   * 操作を再実行することはない（Post/Redirect/Get）。
   */
  readonly result: ResultQuery | null;
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
  request,
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
    // 通常フォーム送信の戻り先では、結果をクエリから組み立てる（NFR-09）。
    result: parseResultQuery(new URL(request.url).search),
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
 * 一括操作で対象 1 台分の結果（FR-11）。
 *
 * `OperationResult` に分類（`code`）を足した形である。`code` は内部の語彙であり、
 * 画面では `skipReasonLabels` を通した日本語だけを出す（SEC-05）。
 */
export type BatchOperationItemResult = OperationResult & {
  /** 実行しなかった理由（`skipped` のときだけ非 null）。 */
  readonly code: PowerOperationRecord['code'];
};

/**
 * 通常フォーム送信のリダイレクトで運ぶ単体操作の結果（NFR-09）。
 *
 * 画面に出すのは操作の種別・結果・対象だけである（SEC-05, FR-07）。
 */
export type SingleResultQuery = {
  readonly kind: 'single';
  readonly operation: PowerOperation;
  readonly result: OperationResultKind;
  readonly target: string;
};

/**
 * 通常フォーム送信のリダイレクトで運ぶ一括操作の結果（NFR-09, FR-11）。
 *
 * `results` と `summary` は fetcher 経由の応答（`BatchOperationResult`）と同じ形に
 * して、画面の描画経路を 1 本に揃える。
 */
/**
 * 一括操作の対象 1 件分の結果（表示用）。
 *
 * `code` を `string` で受けるのは、クエリは利用者が書き換えられるためである。
 * 表示側は既知の語彙かどうかを確かめてから文言を引く。
 */
export type BatchResultItem = {
  readonly target: string;
  readonly operation: PowerOperation;
  readonly result: OperationResultKind;
  readonly code: string | null;
};

/**
 * 通常フォーム送信のリダイレクトで運ぶ一括操作の結果（NFR-09, FR-11）。
 *
 * `results` と `summary` は fetcher 経由の応答（`BatchOperationResult`）と同じ形に
 * して、画面の描画経路を 1 本に揃える。
 */
export type BatchResultQuery = {
  readonly kind: 'batch';
  readonly scope: BatchOperationScope;
  readonly operation: PowerOperation;
  readonly results: ReadonlyArray<BatchResultItem>;
  readonly summary: BatchOperationResult['summary'];
};

/**
 * 操作を受け付けられなかったときの結果表示（NFR-09）。
 *
 * 画面に出すのは固定の文言だけである。サーバーの自由文をクエリで持ち回らない
 * （SEC-05）。
 */
export type ErrorQuery = {
  readonly kind: 'error';
  readonly reason: 'invalid_request' | 'targets_changed';
};

/** クエリから復元した操作の結果表示（単体・一括・失敗のいずれか）。 */
export type ResultQuery = SingleResultQuery | BatchResultQuery | ErrorQuery;

/** 失敗の理由の表示文言（`docs/architecture.md` 4 章の利用者向け文言）。 */
const errorMessages: Record<ErrorQuery['reason'], string> = {
  invalid_request:
    '対象を確定できませんでした。画面を再読み込みしてから操作し直してください。',
  targets_changed:
    '対象が変わりました。画面を再読み込みしてから操作し直してください。',
};

/**
 * 操作を受け付けられなかったときの `303` 応答。
 *
 * 通常フォーム送信でエラーをそのまま JSON で返すと、スクリプト無効時の画面に
 * 生の応答が出る。固定の理由だけをクエリで運び、一覧画面に文言を組み立てさせる。
 */
function errorRedirectResponse(reason: ErrorQuery['reason']): Response {
  return seeOther(`/?result=error&reason=${reason}`);
}

/**
 * 一括操作の結果を 1 つのクエリ値へまとめる。
 *
 * 対象ごとの結果は `対象ID:種別[:理由]` を `;` で連結し、`URLSearchParams` で包む。
 * 複数のクエリ項目に分けると、リダイレクトのたびに個数が変わって読み書きが複雑に
 * なるため、1 項目に収める。
 */
function encodeBatchResult(query: BatchResultQuery): string {
  const items = query.results.map((item) =>
    [item.target, item.result, item.code ?? ''].join(':'),
  );
  return [
    query.scope.type === 'all' ? 'all' : query.scope.id,
    query.operation,
    items.join(';'),
  ].join('|');
}

/**
 * 一括操作の結果を通常フォーム送信の応答（`303`）へ組み立てる。
 *
 * 戻り先の一覧画面はクエリから結果表示を組み立てるため、操作は再実行されない
 * （Post/Redirect/Get, NFR-09）。
 */
function batchRedirectResponse(query: BatchResultQuery): Response {
  return seeOther(
    buildResultLocation(
      encodeBatchResult(query),
      query.summary,
      query.results.length,
    ),
  );
}

/**
 * 単体操作の結果を通常フォーム送信の応答（`303`）へ組み立てる。
 *
 * 対象 ID は定義に使える文字を制限していないため、クエリへ載せる前に必ず
 * エスケープする（`app/lib/runtime-config.server.ts`）。
 */
function singleRedirectResponse(query: SingleResultQuery): Response {
  return seeOther(
    buildResultLocation(
      [query.operation, query.result, query.target].join('|'),
    ),
  );
}

/**
 * 一覧画面へ戻る `Location` を組み立てる。
 *
 * `URLSearchParams` が値のエスケープを行う。対象 ID に任意の文字を定義できるため、
 * 自前で連結するとクエリの区切りと衝突して表示が壊れる。
 */
function buildResultLocation(
  value: string,
  summary?: BatchOperationResult['summary'],
  itemCount?: number,
): string {
  const params = new URLSearchParams({ result: value });
  if (summary !== undefined && itemCount !== undefined) {
    params.set(
      'summary',
      [summary.ok, summary.failed, summary.skipped].join(','),
    );
    // 要約の件数と対象ごとの結果の個数が食い違うクエリは表示しない。
    params.set('count', String(itemCount));
  }
  return `/?${params.toString()}`;
}

/**
 * `Location` のクエリから結果表示を復元する（NFR-09）。
 *
 * 画面に出すのは結果種別と対象だけである（SEC-05）。未知の語彙・個数の合わない値は
 * 結果を表示しない（`null`）。ここで操作を再実行することはない（Post/Redirect/Get）。
 */
export function parseResultQuery(search: string): ResultQuery | null {
  const params = new URLSearchParams(search);
  const raw = params.get('result');
  if (raw === null) return null;

  if (raw === 'error') {
    const reason = params.get('reason');
    if (reason !== 'invalid_request' && reason !== 'targets_changed') {
      return null;
    }
    return { kind: 'error', reason };
  }

  // 一括操作の結果には必ず要約が付く。単体操作と一括操作はどちらも `result` の形が
  // 「要素を `|` で並べたもの」なので、要約の有無で区別する。
  return params.has('summary')
    ? parseBatchQuery(raw, params.get('summary'), params.get('count'))
    : parseSingleQuery(raw);
}

/** 単体操作のクエリ値「操作|種別|対象ID」を読む。 */
function parseSingleQuery(raw: string): ResultQuery | null {
  const parts = raw.split('|');
  if (parts.length !== 3) return null;
  const [operation, result, target] = parts;
  const parsedOperation = parseOperation(operation);
  const parsedResult = parseResultKind(result);
  if (parsedOperation === null || parsedResult === null) return null;
  if (target === undefined) return null;
  return {
    kind: 'single',
    operation: parsedOperation,
    result: parsedResult,
    target,
  };
}

/** 操作の語彙を読む。未知の値は結果を表示しない。 */
function parseOperation(value: string | undefined): PowerOperation | null {
  return value === 'wake' || value === 'shutdown' ? value : null;
}

/** 結果種別の語彙を読む。未知の値は結果を表示しない。 */
function parseResultKind(
  value: string | undefined,
): OperationResultKind | null {
  return value === 'succeeded' ||
    value === 'failed' ||
    value === 'rejected' ||
    value === 'skipped'
    ? value
    : null;
}

/** 一括操作のクエリ値「範囲|操作|対象ID:種別[:理由];...」を読む。 */
function parseBatchQuery(
  raw: string,
  rawSummary: string | null,
  rawCount: string | null,
): ResultQuery | null {
  const [scope, operation, results] = raw.split('|');
  const parsedOperation = parseOperation(operation);
  if (
    parsedOperation === null ||
    scope === undefined ||
    results === undefined
  ) {
    return null;
  }

  const scopeValue = parseScope(scope);
  if (scopeValue === null) return null;

  const items = results.length === 0 ? [] : results.split(';');
  const parsedItems: BatchResultItem[] = [];
  for (const item of items) {
    const parsed = parseBatchItem(item, parsedOperation);
    if (parsed === null) return null;
    parsedItems.push(parsed);
  }

  const summary = parseSummary(rawSummary);
  if (summary === null) return null;

  // 要約と対象ごとの結果が食い違うクエリ（手で書き換えた URL など）は表示しない。
  if (Number(rawCount) !== parsedItems.length) return null;

  return {
    kind: 'batch',
    scope: scopeValue,
    operation: parsedOperation,
    results: parsedItems,
    summary,
  };
}

/** 一括操作の範囲を読む。`all` は全台、それ以外はグループ ID として扱う。 */
function parseScope(value: string): BatchOperationScope | null {
  if (value === 'all') return { type: 'all' };
  return value.length === 0 ? null : { type: 'group', id: value };
}

/** 一括操作の対象 1 件分「対象ID:種別[:理由]」を読む。 */
function parseBatchItem(
  raw: string,
  operation: PowerOperation,
): BatchResultItem | null {
  const [target, result, code] = raw.split(':');
  const parsedResult = parseResultKind(result);
  if (target === undefined || parsedResult === null) return null;
  return {
    target,
    operation,
    result: parsedResult,
    // 理由は表示のためだけに持ち回る。未知の語彙は表示側で落とす。
    code: code === undefined || code === '' ? null : code,
  };
}

/** 要約「成功,失敗,スキップ」を読む。 */
function parseSummary(
  raw: string | null,
): BatchOperationResult['summary'] | null {
  if (raw === null) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 3) return null;
  const [ok, failed, skipped] = parts;
  if (ok === undefined || failed === undefined || skipped === undefined) {
    return null;
  }
  if (![ok, failed, skipped].every((n) => Number.isInteger(n) && n >= 0)) {
    return null;
  }
  return { ok, failed, skipped };
}

/**
 * 一括操作の action が成功時に返す結果（FR-11）。
 *
 * `results` は対象ごとの結果（単体操作と同じ規則で畳み込んだ種別と分類）、`summary` は
 * 「n 件成功 / m 件失敗 / k 件スキップ」の件数である。`target` は要求された範囲
 * （全台またはグループ ID）をそのまま返す。
 */
export type BatchOperationResult = {
  readonly target: BatchOperationScope;
  readonly operation: PowerOperation;
  readonly results: ReadonlyArray<BatchOperationItemResult>;
  readonly summary: {
    readonly ok: number;
    readonly failed: number;
    readonly skipped: number;
  };
};

/**
 * 一括操作の action が失敗時に返す結果。
 *
 * 対象を確定できなかった（未知のグループ・対象 0 台・確認した集合との不一致）場合に
 * 返す。`error` は画面が見分けるための機械可読な識別子で、`message` は利用者向けの
 * 文言である。内部の例外文言は入れない（SEC-05）。
 */
export type BatchOperationFailure = {
  readonly error: 'invalid_request' | 'targets_changed';
  readonly message: string;
};

/** 一括操作の action の応答。成功と失敗を `error` の有無で判別する。 */
export type BatchOperationResponse =
  | BatchOperationResult
  | BatchOperationFailure;

/**
 * 一括操作の応答が失敗かどうかを判定する。
 *
 * action は 400 でも本文を返すため、`fetcher.data` には成功の形と失敗の形のどちらも
 * 入り得る（react-router は非 2xx の `Response` も `data` として扱う）。`summary` を
 * 無検証で読むと、失敗応答で描画時に例外になる。
 */
export function isBatchOperationFailure(
  value: unknown,
): value is BatchOperationFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BatchOperationFailure>;
  return typeof candidate.error === 'string';
}

/**
 * 一括操作の応答が成功かどうかを判定する。
 *
 * 失敗の形（`error`）と取り違えないよう、要約と対象ごとの結果が揃っていることを
 * 確かめる。失敗応答で `summary` を読むと描画時に例外になるため、画面はこの判定を
 * 通った応答だけを描画する。
 */
export function isBatchOperationResult(
  value: unknown,
): value is BatchOperationResult {
  if (typeof value !== 'object' || value === null) return false;
  if (isBatchOperationFailure(value)) return false;
  const candidate = value as Partial<BatchOperationResult>;
  return (
    Array.isArray(candidate.results) &&
    typeof candidate.summary === 'object' &&
    candidate.summary !== null
  );
}

/**
 * 画面に出す結果種別への畳み込み。
 *
 * `busy` は「実行中なので拒否した」を表す。単体操作の操作器は `skipped` + `busy` を返し、
 * 一括操作や予約の `skipped` は「対象を飛ばした」を表す。分類（`code`）が `busy` のときだけ
 * 「実行中（拒否）」とし、それ以外の `skipped` は「スキップ」と出し分ける（FR-07, FR-11）。
 */
export function toResultKind(
  record: {
    readonly result: PowerOperationRecord['result'];
    readonly code: PowerOperationRecord['code'];
  },
  scope: 'single' | 'batch' = 'single',
): OperationResultKind {
  if (record.result === 'succeeded') return 'succeeded';
  // 単体操作の busy は操作器が `{ result: 'skipped', code: 'busy' }` を返す
  // (`app/routes/dashboard.tsx` の action が受ける `PowerOperationRecord`)。`skipped` は
  // 一括操作で実行中の対象を飛ばした意味であり、単体操作の拒否とは表示区分が違うため、
  // `code === 'busy'` を `result === 'skipped'` より先に判定する (FR-07)。
  // 一括操作では busy も含めて「対象を飛ばした」を表すため `skipped` に畳む (FR-11)。
  if (scope === 'batch' && record.result === 'skipped') return 'skipped';
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
 * スクリプト無効時の通常フォーム送信には `303` で `/?result=...` へ戻し、一覧画面が
 * クエリから結果を組み立てる（Post/Redirect/Get, NFR-09）。応答の種別は `Accept` で
 * 決める（`app/lib/form-submission.server.ts`）。
 */
export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get('intent');
  const formSubmission = isFormSubmission(request);

  if (intent === 'wake-group' || intent === 'shutdown-group') {
    return runBatch(
      form,
      context,
      intent === 'wake-group' ? 'wake' : 'shutdown',
      formSubmission,
    );
  }

  const config = requireConfigStore(context).current();
  const target = form.get('target');

  if (intent !== 'wake' && intent !== 'shutdown')
    return badRequest(formSubmission);
  if (typeof target !== 'string') return badRequest(formSubmission);

  const server = config.servers.find((candidate) => candidate.id === target);
  if (server === undefined) return badRequest(formSubmission);

  const record = await requireOperator(context).operate(
    server.id,
    { type: 'server', id: server.id },
    intent,
    server,
    requireSshRuntime(context),
  );

  const result = toResultKind(record);

  if (formSubmission) {
    return singleRedirectResponse({
      kind: 'single',
      target: server.id,
      operation: intent,
      result,
    });
  }

  const body: OperationResult = {
    target: server.id,
    operation: intent,
    result,
  };

  return jsonResponse(body);
}

/**
 * 一括操作の action（FR-11）。
 *
 * `scopeKind` は `all`（全台一括）か `group`（グループ一括）、`scopeKind=group` のときは
 * `scopeId` にグループ ID を受ける。種別と ID を分けるのは、グループ ID に `all` を
 * 定義でき、`scope` 1 つの文字列では全台一括と区別できないためである。対象集合は `resolveBatchTargets` で
 * 確定して ID で重複排除する（1 台 1 回）。結果は単体操作と同じ規則で畳み込み、
 * 対象ごとの結果と要約 `{ ok, failed, skipped }` を返す。部分失敗は全体の失敗に
 * 読み替えず、常に 200 で返す（実行できなかったことは要約と対象ごとの結果で示す）。
 */
async function runBatch(
  form: FormData,
  context: RouterContextProviderLike,
  operation: PowerOperation,
  formSubmission: boolean,
): Promise<Response> {
  const config = requireConfigStore(context).current();
  const rawScopeKind = form.get('scopeKind');
  const rawScopeId = form.get('scopeId');

  // 対象範囲は種別（`all` / `group`）と ID を別の項目で受ける。1 つの文字列にまとめると、
  // グループ ID の `all` と全台一括が区別できず、利用者が選んだグループではなく全台が
  // 対象になる（破壊的操作の対象取り違え）。
  let scope: BatchOperationScope;
  if (rawScopeKind === 'all') {
    scope = { type: 'all' };
  } else if (rawScopeKind === 'group') {
    if (typeof rawScopeId !== 'string' || rawScopeId.length === 0) {
      return batchFailure(...invalidBatch, formSubmission);
    }
    if (!config.groups.some((group) => group.id === rawScopeId)) {
      return batchFailure(...invalidBatch, formSubmission);
    }
    scope = { type: 'group', id: rawScopeId };
  } else {
    return batchFailure(...invalidBatch, formSubmission);
  }

  const targets = resolveBatchTargets(config.servers, scope);
  if (targets.length === 0)
    return batchFailure(...invalidBatch, formSubmission);

  // 確認ダイアログに出した集合と、いま確定した集合が一致するかを照合する。確認のあとで
  // 設定が再読込されたり対象の所属が変わったりしても、利用者が承認していないサーバーを
  // 停止しない（SEC-07）。`confirmed` が無い要求は照合しない（確認を挟まない起動）。
  const rawConfirmed = form.get('confirmed');
  if (typeof rawConfirmed === 'string') {
    const confirmed = rawConfirmed.split(',');
    const current = targets.map((target) => target.id);
    const sameSet =
      confirmed.length === current.length &&
      current.every((id) => confirmed.includes(id));
    if (!sameSet) return batchFailure(...targetsChanged, formSubmission);
  }

  const outcome = await requireOperator(context).operateAll(
    scope,
    operation,
    targets,
    requireSshRuntime(context),
  );

  const results: BatchOperationItemResult[] = outcome.records.map((record) => ({
    target: record.target.id,
    operation: record.operation,
    result: toResultKind(record, 'batch'),
    // `skipped` の理由（`busy` など）を画面まで運ぶ（docs/architecture.md 6.4）。
    code: record.code,
  }));

  if (formSubmission) {
    return batchRedirectResponse({
      kind: 'batch',
      scope,
      operation,
      results,
      summary: outcome.summary,
    });
  }

  const body: BatchOperationResult = {
    target: scope,
    operation,
    results,
    summary: outcome.summary,
  };

  return jsonResponse(body);
}

/** JSON 応答を組み立てる。一覧画面の fetch/action は常に JSON を受ける。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * 一括操作を実行できなかったときの応答内容（状態コードは 400）。
 *
 * `batchFailure` に展開して渡すための組である。
 */
const invalidBatch = [
  'invalid_request',
  '対象を確定できませんでした。画面を再読み込みしてから操作し直してください。',
  400,
] as const;

/**
 * 確認した集合と、いま確定した集合が食い違ったときの応答内容（状態コードは 409）。
 *
 * 確認ダイアログに出した対象と、実際に停止する対象がずれると、利用者が承認していない
 * サーバーを停止し得る。操作は行わず、画面の再読み込みを促す（SEC-07）。
 */
const targetsChanged = [
  'targets_changed',
  '対象が変わりました。画面を再読み込みしてから操作し直してください。',
  409,
] as const;

/**
 * 一括操作を受け付けられなかった応答。
 *
 * `error` は画面が見分けるための識別子、`message` は利用者向けの文言である（内部の
 * 例外文言は入れない）。一括の応答だけ union にするのは、画面が応答の形を検証して
 * 失敗をメッセージ表示に落とせるようにするためである。
 */
function batchFailure(
  error: BatchOperationFailure['error'],
  message: string,
  status: number,
  formSubmission: boolean,
): Response {
  // 通常フォーム送信には JSON を返さない。固定の理由をクエリで運び、一覧画面に
  // 文言を組み立てさせる（NFR-09）。
  if (formSubmission) return errorRedirectResponse(error);

  const body: BatchOperationFailure = { error, message };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * 対象・種別が不正な要求。定義に無いサーバー ID もここに落とす。
 *
 * 通常フォーム送信では `303` で戻す。結果の種別だけを表示し、対象は出さない
 * （定義に無い ID を画面に映さない）。
 */
function badRequest(formSubmission: boolean): Response {
  if (formSubmission) return errorRedirectResponse('invalid_request');

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

/**
 * 「最近の実行」に出す理由の表示文言（FR-13, SEC-05）。
 *
 * リングバッファが持つ分類（`PowerOperationCode`）は内部の語彙であり、英語の識別子を
 * 利用者向けの文言として出さない（`docs/security.md` 4.3）。理由を出すのは
 * 実行しなかった（`skipped`）場合に限る。運用者の操作で失敗した理由はログにのみ残す。
 */
const skipReasonLabels: Record<PowerOperationCode, string> = {
  busy: '実行中のためスキップしました',
  missed_schedule: '実行時刻を過ぎたためスキップしました',
  invalid_configuration: '設定が不正なため実行しませんでした',
  ssh_unavailable: '対象に接続できません',
  operation_failed: '操作に失敗しました',
};

/**
 * 理由欄の文言を引く。`skipped` 以外と未知の分類では理由を出さない（`null`）。
 *
 * 未知の分類をそのまま出さないのは、分類を増やしたときに内部語彙が画面へ漏れるのを
 * 防ぐためである。
 */
export function toReasonLabel(record: {
  readonly result: PowerOperationRecord['result'];
  readonly code: PowerOperationRecord['code'];
}): string | null {
  if (record.result !== 'skipped') return null;
  if (record.code === null) return null;
  return skipReasonLabel(record.code);
}

/**
 * 実行しなかった理由の文言を引く。
 *
 * クエリ由来の理由は利用者が書き換えられるため、既知の語彙でなければ `null` を返し、
 * 内部の文字列を画面へ出さない（SEC-05）。
 */
function skipReasonLabel(code: string): string | null {
  return isSkipReasonCode(code) ? skipReasonLabels[code] : null;
}

/** 実行しなかった理由の語彙かどうか。 */
function isSkipReasonCode(code: string): code is PowerOperationCode {
  return Object.hasOwn(skipReasonLabels, code);
}

/** 状態取得のリソースルートのパス（FR-02）。 */
const statusPath = '/api/status';

/** 「最近の実行」取得のリソースルートのパス（FR-02, FR-13）。 */
const historyPath = '/api/history';

/** ポーリングに使う `fetcher` のうち画面が参照する部分。 */
type PollingFetcher<T> = {
  load: (href: string) => void;
  data?: T;
  state: string;
};

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
  fetcher: PollingFetcher<unknown>,
): Readonly<Record<string, ServerState>> {
  const [states, setStates] = useState(initialStates);
  const lastData = useRef<unknown>(undefined);

  // 毎周期の `fetcher.load` は同じインスタンスを使う。レンダーごとに関数を差し替えない
  // よう、ref 経由で最新の fetcher を参照する。
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // loader が初期状態を返し直したら採り直す（クライアント遷移で戻った場合など）。
  // `useState` の初期値は最初のレンダーでしか使われないため、明示的に追従させる。
  useEffect(() => {
    setStates(initialStates);
  }, [initialStates]);

  useEffect(() => {
    if (fetcher.data === undefined || fetcher.data === lastData.current) return;
    lastData.current = fetcher.data;
    const next = parseStatusResponse(fetcher.data);
    if (next !== null) setStates((previous) => ({ ...previous, ...next }));
  }, [fetcher.data]);

  usePolling(fetcher, statusPath);

  return states;
}

/**
 * 「最近の実行」を同じ周期で更新する（FR-02, FR-13）。
 *
 * ページの loader は再実行しない（`docs/architecture.md` 4.2）。状態の自動更新と同じ
 * タイマーで `/api/history` だけを読み直し、取得できた分だけ差し替える。
 * 4xx/5xx・ネットワーク失敗では直前の履歴を維持する。
 */
export function useHistoryAutoRefresh(
  initialRecords: ReadonlyArray<HistoryRecord>,
  fetcher: PollingFetcher<unknown>,
): ReadonlyArray<HistoryRecord> {
  const [records, setRecords] = useState(initialRecords);
  const lastData = useRef<unknown>(undefined);

  useEffect(() => {
    setRecords(initialRecords);
  }, [initialRecords]);

  useEffect(() => {
    if (fetcher.data === undefined || fetcher.data === lastData.current) return;
    lastData.current = fetcher.data;
    const next = parseHistoryResponse(fetcher.data);
    if (next !== null) setRecords(next);
  }, [fetcher.data]);

  usePolling(fetcher, historyPath);

  return records;
}

/**
 * 一定間隔で `href` を読み込む（FR-02, NFR-08）。
 *
 * - マウント直後はタイマーを張るだけで、周期の開始を待つ。loader（あるいは直前の読み込み）
 *   が取得した結果を捨てて同じ確認をやり直さないためである（NFR-08）。
 * - `visible` に戻った時点では即座に 1 回読み込む（最大 15 秒の空白を作らない）。
 * - `visibilityState` が `hidden` の間はタイマーを止める。
 * - 前周期の読み込みが終わっていないときは次周期を飛ばし、同一対象への確認を
 *   重複して起動しない。
 */
function usePolling(fetcher: PollingFetcher<unknown>, href: string): void {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      timer = setTimeout(tick, statusRefreshIntervalMs);
    };

    const load = () => {
      fetcherRef.current.load(href);
    };

    const tick = () => {
      timer = undefined;
      // 前周期の読み込みが終わっていなければ、この周期は飛ばす（NFR-08）。
      if (fetcherRef.current.state !== 'idle') {
        schedule();
        return;
      }
      load();
      schedule();
    };

    /** タイマーを張る。即時の読み込みはしない（loader 直後の二重確認を避ける）。 */
    const start = () => {
      if (timer !== undefined) return;
      schedule();
    };

    /** 即座に 1 回読み込み、周期を開始する（表示に戻った時点で使う）。 */
    const startNow = () => {
      stop();
      load();
      start();
    };

    const stop = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        startNow();
      } else {
        stop();
      }
    };

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [href]);
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

/**
 * `/api/history` の応答を検証する。
 *
 * 想定外の形（リバースプロキシのエラーページ等）では `null` を返し、表示を変えない。
 * レコードとして解釈できない要素は捨てる。
 */
export function parseHistoryResponse(
  value: unknown,
): ReadonlyArray<HistoryRecord> | null {
  if (typeof value !== 'object' || value === null) return null;
  const records = (value as Partial<HistoryResponse>).records;
  if (!Array.isArray(records)) return null;

  return records.filter(isOperationRecord);
}

/** 画面が扱える実行結果の形かどうか。 */
function isOperationRecord(value: unknown): value is HistoryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<HistoryRecord>;
  if (typeof record.at !== 'string') return false;
  if (typeof record.seq !== 'number') return false;
  if (record.operation !== 'wake' && record.operation !== 'shutdown') {
    return false;
  }
  if (
    record.result !== 'succeeded' &&
    record.result !== 'failed' &&
    record.result !== 'skipped'
  ) {
    return false;
  }
  const target = record.target;
  if (typeof target !== 'object' || target === null) return false;
  if (target.type !== 'server' && target.type !== 'group') return false;
  return typeof target.id === 'string';
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

  // effect の依存を fetcher のオブジェクトではなく値そのものに揃える。
  // `useFetcher()` が返すオブジェクトは毎回別の参照になるため、fetcher ごと依存に
  // 入れると不要な再実行が増える（useExhaustiveDependencies の指摘）。
  const wakeState = wakeFetcher.state;
  const wakeData = wakeFetcher.data;
  const shutdownState = shutdownFetcher.state;
  const shutdownData = shutdownFetcher.data;

  useEffect(() => {
    for (const [operation, state, data] of [
      ['wake', wakeState, wakeData],
      ['shutdown', shutdownState, shutdownData],
    ] as const) {
      if (state !== 'idle' || data === undefined) continue;
      const previous = seen.current[operation];
      // 同じ応答を繰り返し処理しない（再レンダーで送信連番を取り直さない）。
      if (previous?.data === data) continue;
      submitCount.current += 1;
      const entry = { data, count: submitCount.current };
      seen.current[operation] = entry;
      setLatest((current) =>
        current === undefined || entry.count > current.submittedAt
          ? { result: data, submittedAt: entry.count }
          : current,
      );
    }
  }, [wakeState, wakeData, shutdownState, shutdownData]);

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
function RecentRow({ record }: { record: HistoryRecord }) {
  const reason = toReasonLabel(record);

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
      {/* 内部の分類名は出さない。出すのは実行しなかった理由だけである（SEC-05）。 */}
      {reason === null ? null : <span>理由: {reason}</span>}
    </li>
  );
}

/**
 * 一括操作のボタンと結果表示（FR-11）。
 *
 * - 全台一括と、グループごとの一括で共通に使う。対象範囲は `scopeKind`（`all` / `group`）
 *   と `scopeId`（グループ ID）を hidden で送る。
 * - 停止は対象の表示名を列挙した確認を 1 回だけ出し、拒否時は送信しない（SEC-07）。
 * - 結果は対象ごとの種別と「n 件成功 / m 件失敗 / k 件スキップ」の要約を出す。
 */
function BatchControls({
  scope,
  targets,
  names,
}: {
  scope: BatchOperationScope;
  targets: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  names: ReadonlyMap<string, string>;
}) {
  const fetcher = useFetcher<BatchOperationResponse>();
  const running = fetcher.state !== 'idle';
  // 応答が前の要求のものかどうかは fetcher が持ち越さないため、直近の応答だけを出す。
  // 400 の失敗応答も `fetcher.data` に入るため、形を検証してから描画する。
  const data = fetcher.data;
  const failure = isBatchOperationFailure(data) ? data : null;
  const succeeded = isBatchOperationResult(data) ? data : null;

  const submit = (
    event: FormEvent<HTMLFormElement>,
    operation: PowerOperation,
  ) => {
    event.preventDefault();
    if (operation === 'shutdown') {
      // 対象の表示名を列挙し、確認は 1 回だけ出す（FR-11, SEC-07）。
      const listed = targets.map((target) => target.name).join('、');
      if (!window.confirm(`次のサーバーを停止しますか: ${listed}`)) return;
      // 確認した対象を送り、action 側で確定した集合と照合させる。確認のあとに設定が
      // 変わっても、承認していないサーバーを停止しないためである。
      const confirmed = event.currentTarget.elements.namedItem('confirmed');
      if (confirmed instanceof HTMLInputElement) {
        confirmed.value = targets.map((target) => target.id).join(',');
      }
    }
    fetcher.submit(event.currentTarget);
  };

  return (
    <div>
      {(['wake', 'shutdown'] as const).map((operation) => (
        <form
          key={operation}
          method="post"
          onSubmit={(event) => submit(event, operation)}
        >
          <input type="hidden" name="intent" value={`${operation}-group`} />
          <input
            type="hidden"
            name="scopeKind"
            value={scope.type === 'all' ? 'all' : 'group'}
          />
          {scope.type === 'group' ? (
            <input type="hidden" name="scopeId" value={scope.id} />
          ) : null}
          {operation === 'shutdown' ? (
            <input type="hidden" name="confirmed" defaultValue="" />
          ) : null}
          <button type="submit" disabled={running || targets.length === 0}>
            {scope.type === 'all' ? '全台' : 'グループ'}
            {operationLabels[operation]}
          </button>
        </form>
      ))}
      {running ? <span role="status">一括実行中</span> : null}
      {running || data === undefined ? null : failure !== null ? (
        <div role="alert">
          <p>{failure.message}</p>
        </div>
      ) : succeeded !== null ? (
        <div>
          <p>
            {succeeded.summary.ok} 件成功 / {succeeded.summary.failed} 件失敗 /{' '}
            {succeeded.summary.skipped} 件スキップ
          </p>
          <ul>
            {succeeded.results.map((result) => (
              <li key={result.target}>
                {names.get(result.target) ?? result.target}:{' '}
                {resultLabels[result.result]}
                {/* 実行しなかった理由は語彙ではなく日本語で添える（docs/architecture.md 6.4）。 */}
                {result.result === 'skipped' && result.code !== null
                  ? `（${skipReasonLabels[result.code]}）`
                  : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 通常フォーム送信（スクリプト無効時）の結果表示（NFR-09, FR-07）。
 *
 * クエリから組み立てた結果種別と対象だけを出す。行内の結果表示（`ServerRow`）は
 * `fetcher.data` を読むため、ページ全体を読み直す通常フォーム送信では使えない。
 * ここで操作を再実行することはない（Post/Redirect/Get）。
 */
function ResultNotice({
  result,
  names,
}: {
  result: ResultQuery;
  names: ReadonlyMap<string, string>;
}) {
  if (result.kind === 'error') {
    return (
      <div role="alert">
        <p>{errorMessages[result.reason]}</p>
      </div>
    );
  }

  if (result.kind === 'single') {
    return (
      <p role="status">
        {names.get(result.target) ?? result.target}:{' '}
        {operationLabels[result.operation]}: {resultLabels[result.result]}
      </p>
    );
  }

  return (
    <div role="status">
      <p>
        {result.summary.ok} 件成功 / {result.summary.failed} 件失敗 /{' '}
        {result.summary.skipped} 件スキップ
      </p>
      <ul>
        {result.results.map((item) => (
          <li key={item.target}>
            {names.get(item.target) ?? item.target}: {resultLabels[item.result]}
            {/* 実行しなかった理由は語彙ではなく日本語で添える（docs/architecture.md 6.4）。 */}
            {item.result === 'skipped' && item.code !== null
              ? (skipReasonLabel(item.code) ?? '')
              : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const statusFetcher = useFetcher<StatusResponse>();
  const historyFetcher = useFetcher<HistoryResponse>();
  const states = useStatusAutoRefresh(loaderData.states, statusFetcher);
  const recent = useHistoryAutoRefresh(loaderData.recent, historyFetcher);
  const groupNames = new Map(
    loaderData.groups.map((group) => [group.id, group.name]),
  );
  const serverNames = new Map(
    loaderData.servers.map((server) => [server.id, server.name]),
  );
  // グループごとの見出しは、サーバーが 1 台以上所属するグループだけを定義順に出す。
  const groupsWithServers = loaderData.groups
    .map((group) => ({
      group,
      servers: loaderData.servers.filter((server) =>
        server.groups.includes(group.id),
      ),
    }))
    .filter((entry) => entry.servers.length > 0);

  return (
    <section>
      <h2>サーバー一覧</h2>
      {loaderData.result === null ? null : (
        <ResultNotice result={loaderData.result} names={serverNames} />
      )}
      {loaderData.servers.length === 0 ? null : (
        <section aria-label="全台一括">
          <h3>すべてのサーバー</h3>
          <BatchControls
            scope={{ type: 'all' }}
            targets={loaderData.servers}
            names={serverNames}
          />
        </section>
      )}
      {groupsWithServers.map(({ group, servers }) => (
        <section key={group.id} aria-label={`グループ ${group.name}`}>
          <h3>{group.name}</h3>
          <BatchControls
            scope={{ type: 'group', id: group.id }}
            targets={servers}
            names={serverNames}
          />
        </section>
      ))}
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
      {recent.length === 0 ? (
        <p>まだ実行はありません。</p>
      ) : (
        <ul>
          {recent.map((record) => (
            // 同一対象を同一ミリ秒に複数操作しても衝突しない連番で識別する。
            <RecentRow key={record.seq} record={record} />
          ))}
        </ul>
      )}
    </section>
  );
}
