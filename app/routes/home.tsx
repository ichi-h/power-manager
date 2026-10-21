import type { Route } from "./+types/home";
import { requireRuntimeConfig } from "../lib/config.server.ts";
import { requireHistory } from "../lib/history.server.ts";
import type { PowerOperationRecord } from "../lib/power.server.ts";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "power-manager" }];
}

/** loader が画面へ渡すデータ。 */
export type HomeLoaderData = {
  readonly recent: ReadonlyArray<PowerOperationRecord>;
};

/**
 * 仮画面。一覧画面は後続のチケット（t008）で実装する。
 *
 * 画面自体はまだ設定を使わないが、loader で実行時設定を読む。ビルド成果物
 * （`build/server/index.js`）とサーバーエントリが同じ load context のキーを共有して
 * いることを、起動して 1 ページ返すだけで確認できるようにするため（キーが別実体に
 * なると 500 になる）。
 *
 * 「最近の実行」欄（FR-13）はリングバッファ（`app/lib/history.server.ts`）から
 * `recent()` で新しい順に読む。`t008` で一覧と共に表示へ組み込む。
 */
export function loader({ context }: Route.LoaderArgs): HomeLoaderData {
  requireRuntimeConfig(context);
  return { recent: requireHistory(context).recent() };
}

/**
 * 実行結果の行 1 件分。時刻・対象・操作・成否を 1 行で見せる。
 *
 * `t008` で一覧画面の一部として組み込む。ここでは一覧が未実装のため、仮の一覧として
 * 出す。結果の分類（`code`）は `t008` の詳細表示へ委ねる。
 */
function RecentRow({ record }: { record: PowerOperationRecord }) {
  const target =
    record.target.type === "server" ? `サーバー ${record.target.id}` : `グループ ${record.target.id}`;
  return (
    <li>
      <time>{record.at}</time> {target} {record.operation} {record.result}
    </li>
  );
}

export default function Home({ loaderData }: Partial<Route.ComponentProps>) {
  const recent = loaderData?.recent ?? [];
  return (
    <section>
      <p>画面を準備中です。</p>
      <h2>最近の実行</h2>
      {recent.length === 0 ? (
        <p>まだ実行はありません。</p>
      ) : (
        <ul>
          {recent.map((record) => (
            <RecentRow key={`${record.at}:${record.target.id}`} record={record} />
          ))}
        </ul>
      )}
    </section>
  );
}
