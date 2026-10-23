/**
 * スクリプト無効時の通常フォーム送信の判定と、その応答（NFR-09,
 * `docs/architecture.md` 4 章・4.3）。
 *
 * React Router の `fetcher.submit()` は `Accept` を明示せずに要求を送るため、
 * ブラウザ既定の「任意の型」を表す値が付く。一方、スクリプト無効時の通常フォーム送信では
 * ブラウザが `text/html` を含む `Accept` を付ける。したがって「`text/html` を含む
 * 要求」だけを通常のフォーム送信と見なし、それ以外（`fetcher` や API 呼び出し）は
 * 従来どおり JSON 応答の対象とする。
 *
 * 通常のフォーム送信に対しては `303` で一覧へ戻す（Post/Redirect/Get）。戻り先の
 * 画面がクエリから結果表示を組み立てるため、操作が再実行されることはない。
 */

/** 要求がスクリプト無効時の通常フォーム送信かどうか。 */
export function isFormSubmission(request: Request): boolean {
  const accept = request.headers.get('accept');
  return accept !== null && accept.includes('text/html');
}

/**
 * `303 See Other` の応答を組み立てる（Post/Redirect/Get）。
 *
 * 応答本文は持たず、`Location` だけを返す。結果は一時的な値であり、キャッシュさせない。
 */
export function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      'cache-control': 'no-store',
    },
  });
}
