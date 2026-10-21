import {
  createRoutesStub,
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from "react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

import Root, { ErrorBoundary } from "../app/root.tsx";
import Home from "../app/routes/home.tsx";
import NotFound from "../app/routes/not-found.tsx";

describe("画面", () => {
  test("root がアプリケーションのレイアウトを描画する", () => {
    const Stub = createRoutesStub([
      { path: "/", Component: Root, children: [{ index: true, Component: Home }] },
    ]);
    const html = renderToString(<Stub initialEntries={["/"]} />);
    expect(html).toContain("power-manager");
    expect(html).toContain("画面を準備中です。");
  });

  test("未知のパスは見つからない旨を表示する", () => {
    const Stub = createRoutesStub([
      { path: "/", Component: Root, children: [{ path: "*", Component: NotFound }] },
    ]);
    const html = renderToString(<Stub initialEntries={["/unknown"]} />);
    expect(html).toContain("ページが見つかりません");
  });
});

describe("エラーバウンダリ", () => {
  test("内部エラーの詳細を表示しない", async () => {
    const handler = createStaticHandler([
      {
        path: "/",
        Component: Root,
        ErrorBoundary,
        children: [
          {
            index: true,
            Component: Home,
            loader: () => {
              throw new Error("内部の詳細情報");
            },
          },
        ],
      },
    ]);
    const context = await handler.query(new Request("http://localhost/"));
    const html = renderToString(
      <StaticRouterProvider
        router={createStaticRouter(handler.dataRoutes, context as never)}
        context={context as never}
      />,
    );
    expect(html).toContain("処理を完了できませんでした");
    // 詳細は本番モードのハンドラが除外する（sanitizeErrors）。ここでは画面の本文に
    // 現れないことを確認する。
    const visible = html.split("<script>")[0] ?? "";
    expect(visible).not.toContain("内部の詳細情報");
  });
});
