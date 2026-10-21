import type { ServerBuild } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { withAllowedActionOrigins, withErrorHandler } from '../server/app.ts';

/** 差し替えに必要な最小限の形。`withErrorHandler` は他のフィールドを素通しするだけ。 */
function fakeBuild(): ServerBuild {
  return {
    assets: {},
    routes: {},
    entry: { module: { default: () => undefined } },
  } as unknown as ServerBuild;
}

describe('サーバービルドのエラーハンドラ', () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => {
      errors.push(line);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('既定のハンドラを 1 行 JSON のハンドラに差し替える', () => {
    const build = withErrorHandler(fakeBuild());

    build.entry.module.handleError?.(new Error('boom'), {
      request: new Request('http://127.0.0.1/'),
      params: {},
      context: {},
    } as never);

    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0] ?? '')).toEqual({
      event: 'request_failed',
      code: 'internal_error',
      reason: 'boom',
    });
  });

  test('元のビルドの他のフィールドはそのまま残す', () => {
    const original = fakeBuild();
    const replaced = withErrorHandler(original);
    const entryDefault = replaced.entry.module.default;

    expect(replaced.routes).toBe(original.routes);
    expect(replaced.assets).toBe(original.assets);
    expect(entryDefault).toBe(original.entry.module.default);
    // 元のビルドを書き換えない（同じプロセスで複数回読み込んでも副作用が残らない）。
    expect(original.entry.module.handleError).not.toBe(
      replaced.entry.module.handleError,
    );
  });
});

describe('allowedActionOrigins の差し替え', () => {
  test('公開ホストを 1 要素として埋め込む', () => {
    const build = withAllowedActionOrigins(
      fakeBuild(),
      'power.example.ts.net:8443',
    );

    expect(build.allowedActionOrigins).toEqual(['power.example.ts.net:8443']);
  });

  test('元のビルドは書き換えない', () => {
    const original = fakeBuild();
    withAllowedActionOrigins(original, 'power.example.ts.net');

    expect(original.allowedActionOrigins).toBeUndefined();
  });
});
