/**
 * 開発用の要求ハンドラの組み立て（`server/dev.ts` から使う）。
 *
 * 担うこと:
 * - Vite のミドルウェアを先に通し、処理されなかった要求を React Router へ流す
 * - Vite のミドルウェアが例外を `next(error)` で返した場合の 500 応答
 *
 * 担わないこと:
 * - Vite 開発サーバーの起動と待受（`server/dev.ts`）
 * - load context と サーバービルドの用意（呼び出し側が `build` / `getLoadContext` で渡す）
 *
 * `react-router dev`（`@react-router/dev` の Vite プラグイン）は同じ順序で配線しているが、
 * load context を組み立てずに React Router を呼ぶため、
 * 「設定ストアが load context にありません」で loader/action が落ちる。
 * 本番と同じ `createLoadContext` を挿すために、配線だけをここへ切り出す。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { createRequestListener } from '@react-router/node';

/** 応答を書き終えたかどうかの判定に使う最小限の形。 */
type ResponseLike = Pick<
  ServerResponse,
  'headersSent' | 'writeHead' | 'end'
>;

/**
 * Vite のミドルウェア（connect 互換）。
 *
 * 処理しなかった場合に `next()` を呼ぶ。例外は `next(error)` で渡される。
 */
export type DevMiddlewares = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

/** 500 応答。応答を書き始めている場合は本文だけ閉じる（ヘッダーは送信済み）。 */
function internalServerError(response: ResponseLike): void {
  if (!response.headersSent) {
    response.writeHead(500, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }
  response.end('Internal Server Error');
}

export type DevRequestHandlerOptions = {
  /** Vite 開発サーバーのミドルウェア。 */
  middlewares: DevMiddlewares;
  /** React Router の要求ハンドラ（`@react-router/node` の `createRequestListener` の戻り値）。 */
  requestListener: ReturnType<typeof createRequestListener>;
  /** ミドルウェアの例外をログへ出す処理。 */
  logFailure: (error: unknown) => void;
};

/**
 * Vite → React Router の順に要求を処理するハンドラを作る。
 *
 * `appType: 'custom'` の Vite は HTML を代替生成しないため、変換（`/app/*.tsx`）や HMR の
 * 要求を処理した後の `next()` には、画面・データ・リソースの要求だけが来る。
 */
export function createDevRequestHandler({
  middlewares,
  requestListener,
  logFailure,
}: DevRequestHandlerOptions): (
  request: IncomingMessage,
  response: ServerResponse,
) => void {
  return (request, response) => {
    middlewares(request, response, (error?: unknown) => {
      if (error !== undefined) {
        logFailure(error);
        internalServerError(response);
        return;
      }
      // 要求ハンドラは応答を書き切る（例外は内部で `handleError` に渡る）ため、
      // ここでは Promise を待たない。
      void requestListener(request, response);
    });
  };
}
