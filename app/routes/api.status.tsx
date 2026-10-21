/**
 * 状態取得のリソースルート（FR-01, FR-03）。
 *
 * 全サーバーの死活状態を `application/json` で返す。認証は root のミドルウェアが
 * 要求する（FR-10, SEC-01）。UI 内部用のエンドポイントであり、公開 API ではない
 * （`docs/architecture.md` 4 章）。
 *
 * 一覧画面の自動更新（FR-02）は `fetcher.load("/api/status")` でこのルートを呼び、
 * 返ってきた状態だけを行へ反映する。ページの loader は再実行しない。
 *
 * このファイルは client からも参照されるため、server-only の実装へ直接依存しない。
 * 死活確認器（`StatusChecker`）は load context を通して受け取る。キーは
 * `app/lib/status-checker-context.ts` が持ち、実体は `server/app.ts`（server-only）が
 * `createStatusChecker()` で作る。
 */
import { requireConfigStore } from '../lib/config-store.server.ts';
import {
  requireStatusChecker,
  type StatusResponse,
} from '../lib/status-checker-context.ts';

export async function loader({
  context,
}: {
  context: Parameters<typeof requireConfigStore>[0];
}) {
  const config = requireConfigStore(context).current();
  const states = await requireStatusChecker(context).checkAll(config.servers);

  const body: StatusResponse = {
    states: Object.fromEntries(
      config.servers.map((server) => [
        server.id,
        states.get(server.id) ?? 'unknown',
      ]),
    ),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 状態は確認ごとに変わるため、クライアント・中間でのキャッシュを許さない。
      'cache-control': 'no-store',
    },
  });
}
