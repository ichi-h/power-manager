/**
 * 死活確認器の load context キー（FR-01, FR-03）。
 *
 * 一覧画面の loader（`app/routes/dashboard.tsx`）と状態取得のリソースルート
 * （`app/routes/api.status.tsx`）の両方が同じ確認器を使うため、キーを画面・ルートから
 * 独立したモジュールへ置く。ルート同士でキーを import すると、片方の都合（client での
 * 参照範囲など）がもう片方へ漏れる。
 *
 * このモジュールは client ビルドからも参照されるため、server-only の実装
 * （`app/lib/power.server.ts`）へは型だけ依存する。実体は `server/app.ts` が
 * `createStatusChecker()` で作り、`context.set(statusCheckerContext, ...)` で載せる。
 */
import { createContext, type RouterContext } from 'react-router';

import type { ServerState } from './model.ts';
import type { StatusChecker } from './power.server.ts';

/**
 * `GET /api/status` の応答。サーバー ID → 状態の対応。
 *
 * 画面側（`app/routes/dashboard.tsx`）は client でもこの型を参照するため、型だけの
 * 定義をこのモジュールに置く。
 */
export type StatusResponse = {
  readonly states: Readonly<Record<string, ServerState>>;
};

/**
 * `configStoreContext`（`app/lib/config-store.server.ts`）と同じ理由で `globalThis` の
 * スロットを唯一の情報源にする。サーバーエントリと `build/server/index.js` は別の
 * モジュールグラフになるため、モジュールスコープでキーを作ると実体が 2 つになり、
 * loader 側の `context.get` が失敗する。
 */
const statusCheckerContextSlot = '__powerManagerStatusCheckerContext';

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

/** `RouterContextProvider` のうち `requireStatusChecker` が使う部分。テストで差し替えられるようにする。 */
type RouterContextProviderLike = { get: <T>(key: RouterContext<T>) => T };

/**
 * load context から死活確認器を読む。
 *
 * 未設定なら配線不整合である。本番でここに来るのは、`server/app.ts` の
 * `createLoadContext` を経由しない経路を作った場合だけである。
 */
export function requireStatusChecker(
  context: RouterContextProviderLike,
): StatusChecker {
  try {
    return context.get(statusCheckerContext);
  } catch (cause) {
    throw new Error(
      '死活確認器が load context にありません（server/app.ts の createLoadContext を経由していません）',
      { cause },
    );
  }
}
