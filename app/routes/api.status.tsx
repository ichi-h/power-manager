/**
 * 状態取得のリソースルート（FR-01, FR-03）。
 *
 * 全サーバーの死活状態を `application/json` で返す。認証は root のミドルウェアが
 * 要求する（FR-10, SEC-01）。UI 内部用のエンドポイントであり、公開 API ではない
 * （`docs/architecture.md` 4 章）。
 */
import { requireConfigStore } from "../lib/config-store.server.ts";
import { createStatusChecker } from "../lib/power.server.ts";
import type { ServerState } from "../lib/model.ts";

/**
 * 死活確認器は 1 つのプロセスで共有する。対象 ID ごとの進行中 Promise の共有は
 * 確認器の内部状態で実現する（NFR-08）。
 */
const statusChecker = createStatusChecker();

/**
 * 応答の型。サーバー ID → 状態の対応。未確認の対象は `unknown` を返す。
 */
type StatusResponse = { readonly states: Readonly<Record<string, ServerState>> };

export async function loader({ context }: { context: Parameters<typeof requireConfigStore>[0] }) {
  const config = requireConfigStore(context).current();
  const states = await statusChecker.checkAll(config.servers);

  // `unknown` は初期状態であり、未確認の対象を初期値のまま持たせる。
  const body: StatusResponse = {
    states: Object.fromEntries(config.servers.map((server) => [server.id, states.get(server.id) ?? "unknown"])),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
