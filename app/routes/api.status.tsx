/**
 * 状態取得のリソースルート（FR-01, FR-03）。
 *
 * 全サーバーの死活状態を `application/json` で返す。認証は root のミドルウェアが
 * 要求する（FR-10, SEC-01）。UI 内部用のエンドポイントであり、公開 API ではない
 * （`docs/architecture.md` 4 章）。
 *
 * このファイルは client からも参照されるため、server-only の実装へ直接依存しない。
 * 死活確認器（`StatusChecker`）は load context を通して受け取る。実体は
 * `server/app.ts`（server-only）が `createStatusChecker()` で作る。
 */
import { createContext, type RouterContext } from "react-router";

import { requireConfigStore } from "../lib/config-store.server.ts";
import type { ServerState } from "../lib/model.ts";
import type { StatusChecker } from "../lib/power.server.ts";

/**
 * 死活確認器の load context キー。
 *
 * `configStoreContext`（`app/lib/config-store.server.ts`）と同じ理由で `globalThis` の
 * スロットを唯一の情報源にする。サーバーエントリと `build/server/index.js` は別の
 * モジュールグラフになるため、モジュールスコープでキーを作ると実体が 2 つになり、
 * loader 側の `context.get` が失敗する。
 */
const statusCheckerContextSlot = "__powerManagerStatusCheckerContext";

type StatusCheckerContextRegistry = {
  [statusCheckerContextSlot]?: RouterContext<StatusChecker>;
};

const statusCheckerContextRegistry =
  globalThis as unknown as StatusCheckerContextRegistry;

/**
 * 死活確認器の load context キー。`server/app.ts` が実体を設定する。
 *
 * 初期値を持たせない（`createContext<StatusChecker>()`）。server-only の実装を初期値に
 * すると client ビルドからも依存が見えて、React Router の server-code 削除の対象から
 * 外れる。
 */
export const statusCheckerContext: RouterContext<StatusChecker> =
  (statusCheckerContextRegistry[statusCheckerContextSlot] ??=
    createContext<StatusChecker>());

/**
 * 死活確認器を load context から読む。
 *
 * 未設定なら配線不整合である。本番でここに来るのは、`server/app.ts` の
 * `createLoadContext` を経由しない経路を作った場合だけである。
 */
function requireStatusChecker(
  context: Parameters<typeof requireConfigStore>[0],
): StatusChecker {
  return context.get(statusCheckerContext);
}

/**
 * 応答の型。サーバー ID → 状態の対応。
 */
type StatusResponse = {
  readonly states: Readonly<Record<string, ServerState>>;
};

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
        states.get(server.id) ?? "unknown",
      ]),
    ),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 状態は確認ごとに変わるため、クライアント・中間でのキャッシュを許さない。
      "cache-control": "no-store",
    },
  });
}
