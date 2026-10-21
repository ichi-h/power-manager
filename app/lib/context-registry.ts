/**
 * プロセス内で共有する load context キーの置き場。
 *
 * ## 担うこと
 *
 * - `globalThis` 上のスロットを唯一の情報源にした `RouterContext` の取得と生成。
 *
 * ## 担わないこと
 *
 * - スロット名の決定（各モジュールが自分の定数として持つ）。
 * - 値の設定（`server/app.ts` の `createLoadContext` が行う）。
 *
 * `react-router build` が生成する `build/server/index.js`（ルート側）と自前エントリの
 * バンドル（`server/index.js`）は別のモジュールグラフになる。モジュールスコープで
 * `createContext()` すると同じ名前でも実体が 2 つになり、`RouterContextProvider` が
 * キーをオブジェクト同一性で照合するため「No value found for context」で 500 になる。
 *
 * この関数もバンドルごとに複製されるが、複製された実体はどれも `globalThis` の同じ
 * スロットを読み書きするため、どちらのグラフから呼んでも同一の `RouterContext` が返る。
 */
import { createContext, type RouterContext } from 'react-router';

type ContextRegistry = Record<string, RouterContext<unknown> | undefined>;

/**
 * スロット名に対応する `RouterContext` を返す。未生成なら作ってスロットへ書き込む。
 *
 * 同じスロット名で型引数が食い違うと実行時に壊れるため、呼び出し側はスロット定数と
 * 型引数を 1 対 1 に対応させること。
 */
export function sharedRouterContext<T>(slot: string): RouterContext<T> {
  const registry = globalThis as unknown as ContextRegistry;
  const existing = registry[slot];
  if (existing !== undefined) {
    return existing as RouterContext<T>;
  }

  const created = createContext<T>();
  registry[slot] = created as RouterContext<unknown>;
  return created;
}
