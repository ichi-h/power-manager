import type { Route } from './+types/root';
import {
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from 'react-router';
import type { ReactNode } from 'react';

import { authMiddleware } from './lib/auth.server.ts';
import { csrfMiddleware } from './lib/csrf.server.ts';
import './app.css';

/**
 * 画面全体の外枠のクラス。
 *
 * 上部に固定したヘッダーと、余白を広くとったコンテンツ領域で構成する。横幅は
 * 読みやすさを優先して `max-w-6xl` で止め、狭い画面では左右の余白だけを詰める。
 */
const shellClassName =
  'mx-auto w-full max-w-6xl px-6 pt-10 pb-28 sm:px-8 lg:px-12';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f6f7f9" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-canvas text-ink">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/** ナビゲーションの 1 項目。現在地はアクセント色の下線と淡い背景で示す。 */
function NavItem({
  to,
  end,
  children,
}: {
  to: string;
  end?: boolean;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          'rounded-full px-4 py-2 text-sm font-medium transition-colors duration-150',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          isActive
            ? 'bg-accent-soft text-accent'
            : 'text-ink-muted hover:bg-subtle hover:text-ink',
        ].join(' ')
      }
    >
      {children}
    </NavLink>
  );
}

export default function Root() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line/80 bg-canvas/80 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-6 px-6 py-4 sm:px-8 lg:px-12">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-xl bg-ink text-sm font-semibold text-canvas"
            >
              PM
            </span>
            <h1 className="text-base font-semibold tracking-tight">
              power-manager
            </h1>
          </div>
          <nav aria-label="メインナビゲーション" className="flex gap-1.5">
            <NavItem to="/" end>
              一覧
            </NavItem>
            <NavItem to="/settings">設定</NavItem>
          </nav>
        </div>
      </header>
      <main className={shellClassName}>
        <Outlet />
      </main>
    </div>
  );
}

/**
 * 認証と CSRF のミドルウェア（FR-10, SEC-01, SEC-03）。
 *
 * root のミドルウェアは全ルートの子孫へ継承されるため、ここに配列で適用するだけで
 * 画面・action・リソースルートのすべてが対象になる（`docs/security.md` 2.2）。
 * 認証を免除するのは `authMiddleware` 内で判定する `/healthz` のみ（SEC-10）。
 */
export const middleware: Route.MiddlewareFunction[] = [
  authMiddleware,
  csrfMiddleware,
];

/**
 * 本番向けの汎用エラー表示。内部エラーの詳細は表示しない（SEC-05）。
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 pt-24 pb-24 sm:px-8">
      <p className="mb-6 text-sm font-medium tracking-[0.18em] text-ink-subtle uppercase">
        power-manager
      </p>
      <section
        role="alert"
        className="rounded-card border border-line bg-surface p-8 shadow-card sm:p-10"
      >
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          処理を完了できませんでした
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          時間をおいて再度お試しください。
          <span className="ml-2 rounded-full bg-subtle px-2.5 py-1 font-mono text-xs text-ink-subtle">
            {status}
          </span>
        </p>
      </section>
    </main>
  );
}
