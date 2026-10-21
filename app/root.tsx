import type { Route } from "./+types/root";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";
import type { ReactNode } from "react";

import { authMiddleware } from "./lib/auth.server.ts";
import { csrfMiddleware } from "./lib/csrf.server.ts";
import "./app.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return (
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-12">
      <header>
        <h1 className="mb-6 text-2xl font-bold">power-manager</h1>
      </header>
      <Outlet />
    </main>
  );
}

/**
 * 認証と CSRF のミドルウェア（FR-10, SEC-01, SEC-03）。
 *
 * root のミドルウェアは全ルートの子孫へ継承されるため、ここに配列で適用するだけで
 * 画面・action・リソースルートのすべてが対象になる（`docs/security.md` 2.2）。
 * 認証を免除するのは `authMiddleware` 内で判定する `/healthz` のみ（SEC-10）。
 */
export const middleware: Route.MiddlewareFunction[] = [authMiddleware, csrfMiddleware];

/**
 * 本番向けの汎用エラー表示。内部エラーの詳細は表示しない（SEC-05）。
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;

  return (
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-12">
      <header>
        <h1 className="mb-6 text-2xl font-bold">power-manager</h1>
      </header>
      <section
        role="alert"
        className="rounded-lg border border-current px-5 py-4"
      >
        <h2 className="mb-2 text-lg font-bold">処理を完了できませんでした</h2>
        <p>時間をおいて再度お試しください。（{status}）</p>
      </section>
    </main>
  );
}
