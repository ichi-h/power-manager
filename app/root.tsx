import type { ReactNode } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";

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
    <main className="page">
      <header className="page-header">
        <h1>power-manager</h1>
      </header>
      <Outlet />
    </main>
  );
}

/**
 * 本番向けの汎用エラー表示。内部エラーの詳細は表示しない（SEC-05）。
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;

  return (
    <main className="page">
      <header className="page-header">
        <h1>power-manager</h1>
      </header>
      <section role="alert" className="error">
        <h2>処理を完了できませんでした</h2>
        <p>時間をおいて再度お試しください。（{status}）</p>
      </section>
    </main>
  );
}
