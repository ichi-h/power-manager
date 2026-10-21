/**
 * SSH 停止に必要な実行時設定（鍵ファイルと `known_hosts` のパス）の load context キー。
 *
 * 秘密値（鍵そのもの）は鍵ファイルの中にあり、ここへ載せるのはパスだけである。
 * `PublicRuntimeConfig` へ混ぜないのは、画面の loader が意図せず SSH の接続設定を
 * 受け取らないようにするため。一方で action（`app/routes/dashboard.tsx`）は停止操作の
 * 実行にこの 2 つのパスを必要とするため、専用のキーで明示的に渡す。
 *
 * `configContext`（`app/lib/config.server.ts`）と同じ理由で `globalThis` のスロットを
 * 唯一の情報源にする。サーバーエントリと `build/server/index.js` は別のモジュールグラフに
 * なるため、モジュールスコープでキーを作ると実体が 2 つになり、action 側の
 * `context.get` が失敗する。
 */
import { createContext, type RouterContext } from "react-router";

/** SSH 停止の実行に必要なパス。 */
export type SshRuntime = {
  /** SSH 専用秘密鍵の絶対パス。 */
  readonly sshIdentityFile: string;
  /** `known_hosts` の絶対パス。 */
  readonly sshKnownHostsFile: string;
};

const sshRuntimeContextSlot = "__powerManagerSshRuntimeContext";

type SshRuntimeContextRegistry = {
  [sshRuntimeContextSlot]?: RouterContext<SshRuntime>;
};

const sshRuntimeContextRegistry = globalThis as unknown as SshRuntimeContextRegistry;

/** SSH 停止の実行に必要なパスの load context キー。`server/app.ts` が実体を設定する。 */
export const sshRuntimeContext: RouterContext<SshRuntime> = (
  sshRuntimeContextRegistry[sshRuntimeContextSlot] ??= createContext<SshRuntime>()
);

/** `RouterContextProvider` のうち `requireSshRuntime` が使う部分。テストで差し替えられるようにする。 */
type RouterContextProviderLike = { get: <T>(key: RouterContext<T>) => T };

/**
 * load context から SSH 停止のパスを読む。
 *
 * 未設定なら配線不整合である。本番でここに来るのは、`server/app.ts` の
 * `createLoadContext` を経由しない経路を作った場合だけである。
 */
export function requireSshRuntime(context: RouterContextProviderLike): SshRuntime {
  try {
    return context.get(sshRuntimeContext);
  } catch (cause) {
    throw new Error(
      "SSH 停止の設定が load context にありません（server/app.ts の createLoadContext を経由していません）",
      { cause },
    );
  }
}
