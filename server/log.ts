/**
 * リクエスト処理中の失敗を 1 行 JSON で記録する。
 *
 * React Router の既定のエラーハンドラは `console.error(error)` でスタックトレースを
 * 複数行にわたって出す。標準エラーへ 1 行 1 JSON を出す方針（`docs/architecture.md` 7.1）
 * と、内部スタックをログへ出さない方針（`docs/security.md` 4.3）に反するため、自前の
 * ハンドラで置き換える。静的ファイルの配信失敗（`server/index.ts`）も同じ形に揃える。
 */

/** `request_failed` の `code`。分類が粗くても秘密は漏れないため、当てはまらなければ internal にする。 */
export type RequestFailureCode =
  /** action の Origin が公開 Origin と一致しない（CSRF 検査）。 */
  | "csrf_rejected"
  /** Origin ヘッダーの解釈失敗など、React Router が要求を拒否した。 */
  | "request_rejected"
  /** 未捕捉の例外。 */
  | "internal_error";

/**
 * CSRF 検査の失敗かどうか。
 *
 * React Router は専用の例外型も `status` も付けず、メッセージでしか区別できない。
 * 文言の完全一致に依存するとフレームワーク更新で分類が崩れるため前方一致で判定し、
 * 外れたら `internal_error` として扱う。
 */
function isCsrfRejection(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(
      "The `request.url` origin does not match `origin` header from a forwarded action request",
    )
  );
}

/**
 * `reason` に載せてよいのは 1 行に収まる短い説明だけにする。
 * 値・ヘッダー・スタック・パスは載せない（SEC-05）。200 文字を超えたら切り詰める。
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "AbortError") return "aborted";

  const message = error.message.replace(/\s+/g, " ").trim();
  if (message === "") return "unknown";
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/** 失敗の理由を `code` へ分類する。 */
export function classifyRequestFailure(error: unknown): RequestFailureCode {
  if (isCsrfRejection(error)) return "csrf_rejected";
  // React Router は Origin ヘッダーが解釈できない場合も `Error` を投げる。
  if (error instanceof Error && error.message.includes("origin")) return "request_rejected";
  return "internal_error";
}

/** 標準エラーへ 1 行 JSON を出す。 */
export function logRequestFailure(error: unknown): void {
  console.error(
    JSON.stringify({
      event: "request_failed",
      code: classifyRequestFailure(error),
      reason: describeError(error),
    }),
  );
}
