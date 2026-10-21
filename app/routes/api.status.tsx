/**
 * 状態取得のリソースルート（FR-01, FR-03）。
 *
 * 全サーバーの死活状態を `application/json` で返す。認証は root のミドルウェアが
 * 要求する（FR-10, SEC-01）。UI 内部用のエンドポイントであり、公開 API ではない
 * （`docs/architecture.md` 4 章）。
 */
import { createContext, type RouterContext } from "react-router";

import { requireConfigStore } from "../lib/config-store.server.ts";
import {
  createStatusChecker,
  type StatusChecker,
} from "../lib/power.server.ts";
import type { ServerState } from "../lib/model.ts";

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

/** 死活確認器のプロセス共有インスタンス。1 つのプロセスで 1 つだけ作る（NFR-08）。 */
const sharedStatusChecker = createStatusChecker();

/** loader から死活確認器を参照するためのキー。未設定ならプロセス共有の確認器を使う。 */
export const statusCheckerContext: RouterContext<StatusChecker> =
  createContext<StatusChecker>(sharedStatusChecker);

/**
 * 死活確認器を load context から読む。未設定ならプロセス共有の既定値を使う。
 *
 * テストは `context.set(statusCheckerContext, checker)` で確認器を差し替え、本物の
 * TCP 待受に依存しない。
 */
function requireStatusChecker(
  context: Parameters<typeof requireConfigStore>[0],
): StatusChecker {
  try {
    return context.get(statusCheckerContext);
  } catch {
    // 未設定でも落とさない。プロセス共有の既定の確認器をそのまま使う。
    return sharedStatusChecker;
  }
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
