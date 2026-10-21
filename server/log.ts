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
  /** Origin ヘッダーの解釈失敗、405、想定内の 404 など、要求側の問題で拒否した。 */
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
 * `isRouteErrorResponse` 相当の判定。
 *
 * React Router は 404・405 などの想定内の拒否を `ErrorResponseImpl`（`Error` でも
 * `Response` でもない、`status` を持つオブジェクト）で投げる。`instanceof Error` だけで
 * 判定すると、これらが `internal_error` として記録され、内部障害と区別できなくなる。
 * ライブラリの非公開クラスを参照せず、必要な形だけを検査する。
 */
function isRouteErrorResponseLike(
  error: unknown,
): error is { status: number; statusText?: string } {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status <= 599;
}

/**
 * 1 行に収まる短い説明を作る。
 * 値・ヘッダー・スタック・パスは載せない（SEC-05）。200 文字を超えたら切り詰める。
 */
export function describeError(error: unknown): string {
  if (isRouteErrorResponseLike(error)) return `status ${error.status}`;
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "AbortError") return "aborted";

  const message = error.message.replace(/\s+/g, " ").trim();
  if (message === "") return "unknown";
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/** 失敗の理由を `code` へ分類する。 */
export function classifyRequestFailure(error: unknown): RequestFailureCode {
  if (isCsrfRejection(error)) return "csrf_rejected";
  // 405（action を持たないパスへの POST）などは想定内の拒否であり、内部障害ではない。
  if (isRouteErrorResponseLike(error)) return "request_rejected";
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
