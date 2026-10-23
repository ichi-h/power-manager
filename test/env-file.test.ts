import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  applyEnvironmentFile,
  loadEnvironmentFile,
  resolveEnvFilePath,
} from '../server/env-file.ts';

/** テストで書くファイル名。既定の `.env` と衝突させない。 */
const testEnvFileName = 'power-manager-test.env';

describe('環境変数ファイルのパス解決', () => {
  test('未指定なら作業ディレクトリの .env を使う', () => {
    expect(resolveEnvFilePath({}, '/srv/power-manager')).toBe(
      join('/srv/power-manager', '.env'),
    );
  });

  test('空文字は未指定と同じに扱う', () => {
    expect(resolveEnvFilePath({ POWER_MANAGER_ENV_FILE: '' }, '/srv')).toBe(
      join('/srv', '.env'),
    );
  });

  test('指定があればそれを使う', () => {
    expect(
      resolveEnvFilePath({ POWER_MANAGER_ENV_FILE: '/run/secrets/app.env' }),
    ).toBe('/run/secrets/app.env');
  });
});

describe('環境変数ファイルの読み込み', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'power-manager-env-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    delete process.env.POWER_MANAGER_TEST_VALUE;
    delete process.env.POWER_MANAGER_TEST_KEPT;
  });

  test('指定したファイルの値を process.env へ流し込む', () => {
    const path = join(directory, testEnvFileName);
    writeFileSync(path, 'POWER_MANAGER_TEST_VALUE=from-file\n');

    const result = loadEnvironmentFile({ POWER_MANAGER_ENV_FILE: path });

    expect(result.status).toBe('loaded');
    expect(process.env.POWER_MANAGER_TEST_VALUE).toBe('from-file');
  });

  test('既に設定済みの値を上書きしない', () => {
    const path = join(directory, testEnvFileName);
    writeFileSync(path, 'POWER_MANAGER_TEST_KEPT=from-file\n');
    process.env.POWER_MANAGER_TEST_KEPT = 'from-shell';

    loadEnvironmentFile({ POWER_MANAGER_ENV_FILE: path });

    expect(process.env.POWER_MANAGER_TEST_KEPT).toBe('from-shell');
  });

  test('既定のファイルが無いのは正常（missing）', () => {
    const result = loadEnvironmentFile({}, directory);

    expect(result.status).toBe('missing');
    expect(result.path).toBe(join(directory, '.env'));
  });

  test('既定のファイルがあれば読み込む', () => {
    writeFileSync(
      join(directory, '.env'),
      'POWER_MANAGER_TEST_VALUE=from-default\n',
    );

    const result = loadEnvironmentFile({}, directory);

    expect(result.status).toBe('loaded');
    expect(process.env.POWER_MANAGER_TEST_VALUE).toBe('from-default');
  });

  test('明示指定したファイルが無いのは設定不備（rejected）', () => {
    const result = loadEnvironmentFile({
      POWER_MANAGER_ENV_FILE: join(directory, testEnvFileName),
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.code).toBe('ENOENT');
  });

  test('読めないファイルは rejected にして例外を投げない', () => {
    const path = join(directory, testEnvFileName);
    writeFileSync(path, 'POWER_MANAGER_TEST_VALUE=from-file\n', {
      mode: 0o000,
    });

    const result = loadEnvironmentFile({ POWER_MANAGER_ENV_FILE: path });

    expect(result.status).toBe('rejected');
  });
});

describe('起動時の適用', () => {
  test('読み込めたら何もしない', () => {
    const exits: number[] = [];
    applyEnvironmentFile({ POWER_MANAGER_ENV_FILE: '/dev/null' }, (code) => {
      exits.push(code);
    });

    expect(exits).toEqual([]);
  });

  test('読み込めなければ終了コード 78 で止める', () => {
    const exits: number[] = [];
    applyEnvironmentFile(
      { POWER_MANAGER_ENV_FILE: '/nonexistent/power-manager.env' },
      (code) => {
        exits.push(code);
      },
    );

    expect(exits).toEqual([78]);
  });
});
