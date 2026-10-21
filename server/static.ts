/**
 * `react-router build` が生成したクライアント資産を配信する。
 *
 * `createRequestListener` はページとデータ要求のみを扱うため、
 * `/assets/*` の静的ファイルは同じプロセスで自前に返す（NFR-03）。
 */
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../build/client',
);

const assetPrefix = '/assets/';

const contentTypes: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * `/assets/*` の要求を処理したときは `true` を返す。
 * 資産が見つからない場合もここで 404 を返す（画面ルートへフォールバックさせない）。
 * 対象外のパスは呼び出し側でアプリケーションのハンドラへ渡す。
 */
export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;

  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (!pathname.startsWith(assetPrefix)) return false;

  // ディレクトリトラバーサルを防ぐ。許可するのは `/assets/` 直下の 1 階層のみ。
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname.slice(assetPrefix.length));
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad Request');
    return true;
  }

  if (
    relativePath.includes('/') ||
    relativePath.includes('\\') ||
    relativePath.includes('..')
  ) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return true;
  }

  const filePath = path.join(clientDirectory, 'assets', relativePath);

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('not a file');

    response.writeHead(200, {
      'Content-Type':
        contentTypes[path.extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': fileStat.size,
      // 資産はハッシュ付きのファイル名で配信されるため長期間キャッシュできる。
      'Cache-Control': 'public, max-age=31536000, immutable',
    });

    if (method === 'HEAD') {
      response.end();
      return true;
    }

    createReadStream(filePath).pipe(response);
    return true;
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return true;
  }
}
