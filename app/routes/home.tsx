import type { Route } from "./+types/home";
import { requireRuntimeConfig } from "../lib/config.server.ts";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "power-manager" }];
}

/**
 * 仮画面。一覧画面は後続のチケットで実装する。
 *
 * 画面自体はまだ設定を使わないが、loader で実行時設定を読む。ビルド成果物
 * （`build/server/index.js`）とサーバーエントリが同じ load context のキーを共有して
 * いることを、起動して 1 ページ返すだけで確認できるようにするため（キーが別実体に
 * なると 500 になる）。
 */
export function loader({ context }: Route.LoaderArgs) {
  requireRuntimeConfig(context);
  return null;
}

export default function Home() {
  return (
    <section>
      <p>画面を準備中です。</p>
    </section>
  );
}
