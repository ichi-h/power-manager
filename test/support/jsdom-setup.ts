/**
 * jsdom 環境で画面モジュールを読み込むための前処理。
 *
 * `app/root.tsx` や `app/routes/*.tsx` は `react-router` の Vite プラグインが開発時用の
 * React Refresh 前文（preamble）を差し込む。jsdom 上ではその前文が設置済みでないため、
 * 画面モジュールの読み込み時に「can't detect preamble」で失敗する。
 *
 * テストは Vite の開発サーバーではなく Vitest の変換器で走るため、HMR は不要である。
 * そこで前文の設置フラグと React Refresh のフックをその場で用意し、前文を素通りさせる。
 * ブラウザで動かすわけではないので、登録先はダミー関数で足りる。
 *
 * Node 環境のテストでは `window` が無いため何もしない。
 */
const scope = globalThis as unknown as Record<string, unknown>;

if (typeof scope.window === "object" && scope.window !== null) {
  const windowScope = scope.window as Record<string, unknown>;
  windowScope.__vite_plugin_react_preamble_installed__ = true;
  windowScope.$RefreshReg$ = () => {};
  windowScope.$RefreshSig$ = () => (type: unknown) => type;
}
