/**
 * 「最近の実行」取得のリソースルート（FR-13, FR-02）。
 *
 * リングバッファの直近分（上限 100 件）を `application/json` で返す。認証は root の
 * ミドルウェアが要求する（FR-10, SEC-01）。UI 内部用のエンドポイントであり、公開 API
 * ではない（`docs/architecture.md` 4 章）。
 *
 * 一覧画面は `fetcher.load("/api/history")` でこのルートを呼び、返ってきた履歴だけを
 * 差し替える。ページの loader を再実行しないための経路である（`docs/architecture.md` 4.2）。
 * 応答は毎回変わり得るため、キャッシュを許さない。
 *
 * このファイルは client からも参照されるため、server-only の実装へ直接依存しない。
 * リングバッファは load context（`requireHistory`）を通して受け取る。
 */
import type { HistoryResponse } from '../lib/history-context.ts';
import { requireHistory } from '../lib/history.server.ts';

export function loader({
  context,
}: {
  context: Parameters<typeof requireHistory>[0];
}) {
  const body: HistoryResponse = { records: requireHistory(context).recent() };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 履歴は操作のたびに変わるため、クライアント・中間でのキャッシュを許さない。
      'cache-control': 'no-store',
    },
  });
}
