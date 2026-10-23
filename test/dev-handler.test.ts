import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, test, vi } from 'vitest';

import { createDevRequestHandler } from '../server/dev-handler.ts';

/**
 * 応答の記録だけを行う最小限の `ServerResponse`。
 *
 * Node の実物を使わずに、ヘッダーと本文の書き込み順だけを確かめる。
 */
class FakeResponse extends EventEmitter {
  status: number | undefined;
  headers: Record<string, string> = {};
  body = '';
  endCalled = false;

  get headersSent(): boolean {
    return this.status !== undefined;
  }

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status;
    Object.assign(this.headers, headers);
    return this;
  }

  end(chunk?: string): this {
    if (chunk !== undefined) this.body += chunk;
    this.endCalled = true;
    return this;
  }
}

function asResponse(response: FakeResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

/** 未使用の要求（ハンドラは中身を見ない）。 */
const request = {} as IncomingMessage;

describe('開発用の要求ハンドラ', () => {
  test('Vite が処理しなかった要求を React Router へ渡す', () => {
    const calls: string[] = [];
    const requestListener = vi.fn(async () => {
      calls.push('router');
      return undefined;
    });
    const handler = createDevRequestHandler({
      middlewares: (_request, _response, next) => {
        calls.push('vite');
        next();
      },
      requestListener: requestListener as never,
      logFailure: () => undefined,
    });

    handler(request, asResponse(new FakeResponse()));

    expect(calls).toEqual(['vite', 'router']);
  });

  test('Vite が応答を書き終えた要求は React Router へ渡さない', () => {
    const requestListener = vi.fn(async () => undefined);
    const handler = createDevRequestHandler({
      middlewares: (_request, response) => {
        // connect のミドルウェアは、応答を書き終えたら `next` を呼ばない。
        (response as unknown as FakeResponse).end('assets');
      },
      requestListener: requestListener as never,
      logFailure: () => undefined,
    });

    const response = new FakeResponse();
    handler(request, asResponse(response));

    expect(requestListener).not.toHaveBeenCalled();
    expect(response.body).toBe('assets');
  });

  test('ミドルウェアの例外はログへ出して 500 を返す', () => {
    const logged: unknown[] = [];
    const requestListener = vi.fn(async () => undefined);
    const handler = createDevRequestHandler({
      middlewares: (_request, _response, next) => {
        next(new Error('transform failed'));
      },
      requestListener: requestListener as never,
      logFailure: (error) => {
        logged.push(error);
      },
    });

    const response = new FakeResponse();
    handler(request, asResponse(response));

    expect(logged).toHaveLength(1);
    expect(response.status).toBe(500);
    expect(response.body).toBe('Internal Server Error');
    expect(requestListener).not.toHaveBeenCalled();
  });

  test('応答を書き始めていれば 500 でもヘッダーを書き直さない', () => {
    const handler = createDevRequestHandler({
      middlewares: (_request, response, next) => {
        const fake = response as unknown as FakeResponse;
        fake.writeHead(200, { 'Content-Type': 'text/html' });
        next(new Error('stream broken'));
      },
      requestListener: vi.fn(async () => undefined) as never,
      logFailure: () => undefined,
    });

    const response = new FakeResponse();
    handler(request, asResponse(response));

    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toBe('text/html');
  });
});
