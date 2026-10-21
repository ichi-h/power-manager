import type { Route } from "./+types/home";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "power-manager" }];
}

/**
 * 仮画面。一覧画面は後続のチケットで実装する。
 */
export default function Home() {
  return (
    <section>
      <p>画面を準備中です。</p>
    </section>
  );
}
