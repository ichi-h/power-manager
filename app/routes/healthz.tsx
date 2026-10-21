/**
 * 死活監視エンドポイント（SEC-10）。
 *
 * 認証を免除する代わりに、`ok` の固定文字列のみを返す。
 * JSON・バージョン・稼働時間・設定状態を含めない（`docs/architecture.md` 4 章）。
 */
export function loader() {
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}