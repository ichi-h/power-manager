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
import { RouterContextProvider } from 'react-router';
import { describe, expect, test } from 'vitest';

import { configStoreContext, createConfigStore } from '../app/lib/config-store.server.ts';
import { parseManagedConfig } from '../app/lib/runtime-config.server.ts';
import Root, { ErrorBoundary } from '../app/root.tsx';
import Confirm, { loader as confirmLoader } from '../app/routes/confirm.tsx';
import Dashboard, {
  type DashboardLoaderData,
} from '../app/routes/dashboard.tsx';
import NotFound from '../app/routes/not-found.tsx';
import { validManagedConfig } from './support/managed-config.ts';

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

/**
 * 停止の確認ページ（`/confirm`）のサーバー描画。
 *
 * スクリプト無効時は `window.confirm` が使えず、確認はこのページだけが担う（NFR-09,
 * SEC-07）。したがって対象の表示名が HTML に現れ、確認済みの値を送るボタンと
 * 隠し項目が揃っていることをサーバー描画で確かめる。
 */
describe('停止の確認ページ', () => {
  /** 2 台のサーバーを持つ設定。グループ一括の列挙を見るために 1 台では足りない。 */
  function twoServerConfig() {
    const config = validManagedConfig();
    (config.servers as Array<Record<string, unknown>>).push({
      id: 'test-01',
      name: '検証機 01',
      groups: ['storage'],
      macAddress: '00:11:22:33:44:66',
      ssh: {
        host: 'test-01.example.internal',
        user: 'power-manager',
        shutdownCommand: 'sudo systemctl poweroff',
      },
    });
    return config;
  }

  /** `requireConfigStore` が読む load context。 */
  function contextWith(config: Record<string, unknown>) {
    const context = new RouterContextProvider();
    context.set(
      configStoreContext,
      createConfigStore(
        '/etc/power-manager/config.json',
        parseManagedConfig(config),
      ),
    );
    return context;
  }

  /**
   * 確認ページの loader を呼ぶ。
   *
   * 対象が定義に無いときの loader は `Response` を `throw` する（React Router の
   * redirect と同じ扱い）。呼び出し側が戻り値と例外を取り違えないよう、ここで
   * `{ kind: 'redirect', response }` に畳む。
   */
  function runConfirmLoader(
    url: string,
    config = twoServerConfig(),
  ):
    | { readonly kind: 'data'; readonly data: unknown }
    | { readonly kind: 'redirect'; readonly response: Response } {
    try {
      return {
        kind: 'data',
        data: confirmLoader({
          context: contextWith(config),
          request: new Request(`http://localhost${url}`),
        } as never),
      };
    } catch (error) {
      if (error instanceof Response) return { kind: 'redirect', response: error };
      throw error;
    }
  }

  /** loader の redirect を検証しやすい形にする。 */
  function expectRedirect(url: string, config = twoServerConfig()) {
    const result = runConfirmLoader(url, config);
    expect(result.kind, url).toBe('redirect');
    if (result.kind !== 'redirect') return;
    expect(
      [
        result.response.status,
        result.response.headers.get('location'),
        result.response.headers.get('cache-control'),
      ],
      url,
    ).toEqual([303, '/', 'no-store']);
  }

  /** loader を通して確認ページを描画する（loader→Component の配線も同時に見る）。 */
  async function renderConfirm(
    url: string,
    config = twoServerConfig(),
  ): Promise<string> {
    const handler = createStaticHandler([
      {
        path: '/confirm',
        // `Confirm` は loader の戻り値を前提にした props 型を持つため、ここだけ型を伏せる
        // （実行時は `Confirm` のまま。loader の戻り値が props として渡る）。
        Component: Confirm as never,
        loader: () => {
          const result = runConfirmLoader(url, config);
          if (result.kind === 'redirect') throw result.response;
          return result.data;
        },
      },
    ]);
    const context = await handler.query(new Request(`http://localhost${url}`));
    return renderToString(
      <StaticRouterProvider
        router={createStaticRouter(handler.dataRoutes, context as never)}
        context={context as never}
      />,
    );
  }

  test('単体の停止では対象の表示名を 1 件だけ列挙する', async () => {
    const html = await renderConfirm('/confirm?kind=server&target=nas');
    expect(html).toContain('停止の確認');
    expect(html).toContain('NAS');
    expect(html).not.toContain('検証機 01');
    // 確認済みの値と対象 ID を hidden で送る（action 側で照合する, SEC-07）。
    expect(html).toContain('name="intent" value="shutdown"');
    expect(html).toContain('name="target" value="nas"');
    expect(html).toContain('name="confirmed" value="nas"');
  });

  test('グループ一括の停止では対象の表示名をすべて列挙する', async () => {
    const html = await renderConfirm(
      '/confirm?kind=batch&scopeKind=group&scopeId=storage',
    );
    expect(html).toContain('NAS');
    expect(html).toContain('検証機 01');
    // 確定した集合を照合できるよう、定義順の ID を並べて送る。
    expect(html).toContain('name="confirmed" value="nas,test-01"');
    expect(html).toContain('name="scopeKind" value="group"');
    expect(html).toContain('name="scopeId" value="storage"');
  });

  test('全台一括の停止では scopeId を送らない（グループと取り違えない）', async () => {
    const html = await renderConfirm('/confirm?kind=batch&scopeKind=all');
    expect(html).toContain('name="scopeKind" value="all"');
    expect(html).not.toContain('name="scopeId"');
  });

  test('定義に無い対象・未知の範囲では一覧へ 303 で戻す', () => {
    for (const url of [
      '/confirm?kind=server&target=unknown',
      '/confirm?kind=batch&scopeKind=group&scopeId=unknown',
      '/confirm?kind=batch',
      '/confirm',
    ]) {
      expectRedirect(url);
    }
  });

  test('サーバーが 0 台の全台一括は確認できない（303 で戻す）', () => {
    const config = validManagedConfig();
    config.servers = [];
    config.groups = [];
    expectRedirect('/confirm?kind=batch&scopeKind=all', config);
  });
});
