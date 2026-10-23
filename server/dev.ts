/**
 * 開発用サーバーのエントリポイント（`npm run dev`）。
 *
 * `react-router dev` の代わりに自前で待受ける。`react-router dev`（Vite プラグインの
 * 開発サーバー）は load context を組み立てないため、`createLoadContext` を経由せず
 * loader/action が「設定ストアが load context にありません」で失敗する。
 * ここでは Vite を middlewareMode で起動し、本番と同じ `createLoadContext` を
 * `createRequestListener` に配線する。
 *
 * 担うこと:
 * - Vite 開発サーバー（HMR・Tailwind・パス解決）の起動と HTTP 待受
 * - `virtual:react-router/server-build` を要求ごとに読み直し、ビルドと同じ後処理
 *   （エラーハンドラ・CSRF 用 Origin の差し替え）を施す
 * - load context の組み立て（`server/app.ts` と共通）
 *
 * 担わないこと:
 * - 環境変数と管理対象 JSON の検証（`server/startup.ts` に委ねる）
 * - 予約の実行（`ensureScheduleRunner` を呼ばないため、開発時は動かない。
 *   `docs/architecture.md` 3.3）
 * - 本番の待受（`server/index.ts`）
 *
 * `react-router` は `--conditions=development` 付きで起動する（`package.json` の `dev`）。
 * 付けないと、このエントリが直接 import する `react-router` と、Vite が SSR 用に解決する
 * `react-router` が別の実体になり、`RouterContextProvider` の `instanceof` 判定が外れる
 * （`react-router` の `exports` は `development` 条件で別ファイルを指す）。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createRequestListener } from '@react-router/node';
import type { ServerBuild } from 'react-router';
import {
  createServer as createViteServer,
  isRunnableDevEnvironment,
  type ViteDevServer,
} from 'vite';

import { configurationErrorExitCode } from '../app/lib/exit-codes.ts';
import {
  createLoadContext,
  withAllowedActionOrigins,
  withErrorHandler,
} from './app.ts';
import { createDevRequestHandler } from './dev-handler.ts';
import { logRequestFailure } from './log.ts';
import { exitAfterStartupFailure, startRuntime } from './startup.ts';

/** 開発時に読み込む仮想モジュール。`@react-router/dev` の Vite プラグインが提供する。 */
const serverBuildModuleId = 'virtual:react-router/server-build';

// `react-router dev` と同じく、指定がなければ開発モードとして扱う。未設定のままだと
// 環境変数の検証が本番向けになり、`http://localhost` の Origin が拒否される。
process.env.NODE_ENV ??= 'development';

/**
 * 要求に応答する関数。
 *
 * 起動時は 503 を返す実体を入れておき、Vite と React Router の準備ができてから
 * 差し替える（待受開始と準備完了の競合を避ける）。
 */
let handleRequest: (
  request: IncomingMessage,
  response: ServerResponse,
) => void = (_request, response) => {
  response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Starting up');
};

let startup;
try {
  startup = await startRuntime();
} catch (error) {
  exitAfterStartupFailure(error);
}

const { runtime, configStore } = startup;

/**
 * HTTP サーバーを先に作り、Vite には HMR 用の WebSocket をこのサーバーへ相乗りさせる。
 *
 * `middlewareMode` では Vite 自身は待受けない。`hmr.server` を渡さないと HMR 用の
 * WebSocket が別ポートで待受けることになる。
 */
const server = createServer((request, response) => {
  handleRequest(request, response);
});

/** 待受アドレスの不備として扱う `error.code`。本番（`server/index.ts`）と同じ分類。 */
const listenAddressErrorCodes = new Set(['EADDRINUSE', 'EACCES', 'EINVAL']);

server.on('error', (error: NodeJS.ErrnoException) => {
  const isListenAddressError =
    error.code !== undefined && listenAddressErrorCodes.has(error.code);
  console.error(
    JSON.stringify({
      event: 'startup_failed',
      code: isListenAddressError ? 'invalid_configuration' : 'operation_failed',
      reason: error.message,
    }),
  );
  process.exit(isListenAddressError ? configurationErrorExitCode : 1);
});

server.listen(runtime.port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'started', port: runtime.port }));
});

let vite: ViteDevServer;
try {
  vite = await createViteServer({
    // React Router が HTML を組み立てるため、Vite に HTML を代替生成させない。
    appType: 'custom',
    server: {
      middlewareMode: true,
      hmr: { server },
    },
  });
} catch (error) {
  // 待受を始めた後なので、終了コードではなく 1 行ログで原因を示して落とす。
  console.error(
    JSON.stringify({
      event: 'startup_failed',
      code: 'operation_failed',
      reason: error instanceof Error ? error.name : 'unknown',
    }),
  );
  process.exit(1);
}

/**
 * 要求のたびにサーバービルドを読み直す。
 *
 * Vite のモジュールランナーは変更されたモジュールだけを無効化するため、変更がなければ
 * キャッシュが返る。route の編集が再起動なしに反映される点は `react-router dev` と同じ。
 */
async function loadDevServerBuild(): Promise<ServerBuild> {
  const ssrEnvironment = vite.environments.ssr;
  if (!isRunnableDevEnvironment(ssrEnvironment)) {
    throw new Error(
      'ssr 環境が runnable ではありません（vite.config.ts の ssr 設定を確認してください）',
    );
  }
  const build = (await ssrEnvironment.runner.import(
    serverBuildModuleId,
  )) as unknown as ServerBuild;
  return withErrorHandler(
    withAllowedActionOrigins(build, runtime.publicOriginHost),
  );
}

/**
 * Vite のミドルウェアを通してから React Router に渡す。
 *
 * 配線そのものは `server/dev-handler.ts` にある（Vite を起動せずにテストできるように
 * するため）。ここでは本番と同じ load context を挿す。
 */
handleRequest = createDevRequestHandler({
  middlewares: (request, response, next) => {
    vite.middlewares(request, response, next);
  },
  requestListener: createRequestListener({
    build: loadDevServerBuild,
    // 開発用の挙動（`processRequestError` でスタックを整形する）を有効にする。
    mode: 'development',
    // 本番と同じ load context を載せる。予約実行器は production のみのため渡さない。
    getLoadContext: () => createLoadContext(runtime, configStore),
  }),
  logFailure: logRequestFailure,
});
console.log(
  JSON.stringify({ event: 'dev_server', url: runtime.publicOrigin }),
);

let shuttingDown = false;

/** 開発用のため強制終了はせず、Vite の後始末を待ってから閉じる。 */
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  void vite.close().then(() => {
    server.close(() => {
      process.exit(0);
    });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
