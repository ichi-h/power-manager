/**
 * 画面の骨格の検証。
 *
 * root は `react-router` の Vite プラグインが注入する前文（preamble）に依存するため、
 * jsdom へそのまま描画できない。そのため root を伴う描画はサーバー描画
 * （`renderToString`）で確認する。操作を伴う検証は `test/dashboard-screen.test.tsx`。
 */
import {
  createRoutesStub,
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from 'react-router';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import Root, { ErrorBoundary } from '../app/root.tsx';
import Dashboard, {
  type DashboardLoaderData,
} from '../app/routes/dashboard.tsx';
import NotFound from '../app/routes/not-found.tsx';

const loaderData: DashboardLoaderData = {
  servers: [{ id: 'nas', name: 'NAS', groups: ['storage'] }],
  groups: [{ id: 'storage', name: 'ストレージ' }],
  states: { nas: 'online' },
  recent: [],
  result: null,
};

describe('画面', () => {
  test('root がアプリケーションのレイアウトを描画する', async () => {
    const handler = createStaticHandler([
      {
        path: '/',
        Component: Root,
        children: [
          {
            index: true,
            // loader の戻り値がそのまま Component の props になる（配線も一緒に検証する）。
            // 子ルートの props 型は `createStaticHandler` が推論できないため、型だけを
            // 伏せる（実行時は `Dashboard` のまま。props は loader の戻り値が渡る）。
            Component: Dashboard as never,
            loader: () => loaderData,
          },
        ],
      },
    ]);
    const context = await handler.query(new Request('http://localhost/'));
    const html = renderToString(
      <StaticRouterProvider
        router={createStaticRouter(handler.dataRoutes, context as never)}
        context={context as never}
      />,
    );
    expect(html).toContain('power-manager');
    expect(html).toContain('サーバー一覧');
    // 一覧の行がサーバー側で描画される（スクリプト無効時も一覧が読める, NFR-09）。
    // React の補間マーカー（`<!-- -->`）に依存しないよう、前後の語を別々に検査する。
    expect(html).toContain('状態:');
    expect(html).toContain('オンライン');
    // loader の戻り値が行として描画される（loader→Component の配線も同時に検証する）。
    expect(html).toContain('NAS');
    expect(html).toContain('所属グループ:');
    expect(html).toContain('ストレージ');
  });

  test('未知のパスは見つからない旨を表示する', () => {
    const Stub = createRoutesStub([
      {
        path: '/',
        Component: Root,
        children: [{ path: '*', Component: NotFound }],
      },
    ]);
    const html = renderToString(<Stub initialEntries={['/unknown']} />);
    expect(html).toContain('ページが見つかりません');
  });
});

describe('エラーバウンダリ', () => {
  test('内部エラーの詳細を表示しない', async () => {
    const handler = createStaticHandler([
      {
        path: '/',
        Component: Root,
        ErrorBoundary,
        children: [
          {
            index: true,
            Component: () => null,
            loader: () => {
              throw new Error('内部の詳細情報');
            },
          },
        ],
      },
    ]);
    const context = await handler.query(new Request('http://localhost/'));
    const html = renderToString(
      <StaticRouterProvider
        router={createStaticRouter(handler.dataRoutes, context as never)}
        context={context as never}
      />,
    );
    expect(html).toContain('処理を完了できませんでした');
    // 詳細は本番モードのハンドラが除外する（sanitizeErrors）。ここでは画面の本文に
    // 現れないことを確認する。
    const visible = html.split('<script>')[0] ?? '';
    expect(visible).not.toContain('内部の詳細情報');
  });
});
