/**
 * 設定画面の描画と再読込の進行表示の検証（FR-07, FR-08, FR-14）。
 *
 * サーバー側の loader / action の入出力は `test/settings.test.ts` が受け持つ。
 * ここでは jsdom 上で、画面遷移を起こさずに進行中・結果だけが出ることを確かめる。
 */
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';

import Settings, {
  type ReloadPayload,
  type SettingsLoaderData,
} from '../app/routes/settings.tsx';

/** 1 台・1 グループ・1 予約の画面データ。 */
function loaderData(
  overrides: Partial<SettingsLoaderData> = {},
): SettingsLoaderData {
  return {
    configPath: '/etc/power-manager/config.json',
    servers: [
      {
        id: 'nas',
        name: 'NAS',
        groups: ['ストレージ'],
        host: 'nas.example.internal',
        port: 22,
        macAddress: '00:11:22:33:44:55',
        broadcastAddress: '192.168.1.255',
        wolPort: 9,
      },
    ],
    groups: [{ id: 'storage', name: 'ストレージ' }],
    schedules: [
      {
        id: 'night-shutdown',
        name: '夜間停止',
        enabled: true,
        operation: '停止',
        target: 'グループ ストレージ',
        repeat: '毎日 23:30',
      },
    ],
    ...overrides,
  };
}

/**
 * 設定画面のルートを組む。
 *
 * `action` に Promise を返させれば、送信中の表示を観察できる。
 */
function renderSettings(
  data: SettingsLoaderData,
  options: {
    action?: () => ReloadPayload | Response | Promise<ReloadPayload>;
  } = {},
) {
  const Stub = createRoutesStub([
    {
      path: '/settings',
      Component: Settings,
      loader: () => data,
      action: async () =>
        options.action?.() ?? { result: 'succeeded', schedules: 1 },
    },
  ]);

  return render(<Stub initialEntries={['/settings']} />);
}

afterEach(() => {
  cleanup();
});

describe('設定画面の描画', () => {
  test('サーバー・グループ・予約を読み取り専用で表示する', async () => {
    renderSettings(loaderData());

    expect(await screen.findByText('NAS')).toBeDefined();
    expect(screen.getByText('ID: nas')).toBeDefined();
    expect(screen.getByText('所属グループ: ストレージ')).toBeDefined();
    expect(screen.getByText('接続先: nas.example.internal:22')).toBeDefined();
    expect(screen.getByText('MAC アドレス: 00:11:22:33:44:55')).toBeDefined();
    expect(screen.getByText('WOL: 192.168.1.255:9')).toBeDefined();
    expect(screen.getByText('ストレージ')).toBeDefined();
    expect(screen.getByText('夜間停止')).toBeDefined();
    expect(screen.getByText('対象: グループ ストレージ')).toBeDefined();
    expect(screen.getByText('操作: 停止')).toBeDefined();
    expect(screen.getByText('毎日 23:30')).toBeDefined();
    expect(screen.getByText('/etc/power-manager/config.json')).toBeDefined();
    // 定義の編集手段は提供しない（CON-09）。
    expect(document.querySelector('form input[name="intent"]')).not.toBeNull();
    expect(document.querySelector('input[type="text"]')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('登録が無いときはその旨を表示する', async () => {
    renderSettings(loaderData({ servers: [], groups: [], schedules: [] }));

    expect(
      await screen.findByText('サーバーが登録されていません。'),
    ).toBeDefined();
    expect(screen.getByText('グループが登録されていません。')).toBeDefined();
    expect(screen.getByText('予約が登録されていません。')).toBeDefined();
  });

  test('無効な予約は無効と表示する', async () => {
    const data = loaderData();
    renderSettings({
      ...data,
      schedules: [{ ...data.schedules[0]!, enabled: false }],
    });

    expect(await screen.findByText('無効')).toBeDefined();
  });
});

describe('再読込の進行表示と結果', () => {
  test('開始直後から進行中を表示し、完了後は結果種別を出す', async () => {
    let finish: (payload: ReloadPayload) => void = () => {};
    renderSettings(loaderData(), {
      action: () =>
        new Promise<ReloadPayload>((resolve) => {
          finish = resolve;
        }),
    });

    const button = await screen.findByText('定義を再読込');
    button.click();

    // 送信中は「再読込中」だけを出す（結果はまだ出さない）。
    expect(await screen.findByText('再読込中')).toBeDefined();
    expect(screen.queryByText(/再読込: 成功/)).toBeNull();

    finish({ result: 'succeeded', schedules: 2 });

    expect(await screen.findByText(/再読込: 成功/)).toBeDefined();
    // 結果種別だけを表示する。件数などの対象の詳細は FR-07 の表示範囲外である（bd05）。
    expect(screen.queryByText(/再計算/)).toBeNull();
    expect(screen.queryByText('再読込中')).toBeNull();
  });

  test('失敗のときは失敗という結果種別だけを出す', async () => {
    renderSettings(loaderData(), {
      action: () => ({ result: 'failed' }),
    });

    (await screen.findByText('定義を再読込')).click();

    expect(await screen.findByText('再読込: 失敗')).toBeDefined();
    // 失敗理由（内部メッセージ）は画面に出さない（FR-07, SEC-05）。
    expect(document.body.textContent).not.toContain('検証');
  });

  test('予約実行器が無いときも結果種別だけを出す', async () => {
    renderSettings(loaderData(), {
      action: () => ({ result: 'succeeded', schedules: null }),
    });

    (await screen.findByText('定義を再読込')).click();

    expect(await screen.findByText('再読込: 成功')).toBeDefined();
    expect(screen.queryByText(/再計算/)).toBeNull();
  });

  test('想定外の応答では結果を表示しない', async () => {
    renderSettings(loaderData(), {
      action: () => ({ error: 'invalid_request' }) as never,
    });

    (await screen.findByText('定義を再読込')).click();

    // 送信が終わったことを待つ（進行中の表示が消える）。
    await screen.findByText('定義を再読込');
    expect(screen.queryByText(/再読込:/)).toBeNull();
  });
});
