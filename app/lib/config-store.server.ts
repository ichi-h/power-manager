/**
 * 管理対象 JSON の設定ストア。
 *
 * 稼働中の再読込（FR-08）と、loader/action からの参照（FR-03, FR-12）を担う。
 * 設計上の要点は 3 つ。
 *
 * 1. 差し替えは原子的に行う。候補を読み込んで全体検証し、成功したときだけ有効設定を
 *    差し替える。検証の途中で有効設定を書き換えないため、失敗時は直前の有効設定が
 *    そのまま残る（NFR-13, FR-08）。
 * 2. 失敗しても例外を投げない。再読込は action から呼ばれ、失敗は「結果種別のみ画面に
 *    出す」対象である（FR-07, FR-08）。例外にするとエラーバウンダリに落ち、失敗理由が
 *    画面に出てしまう。
 * 3. 保持するのは検証済みの値だけである。`ManagedConfig` 型の値はスキーマ検証と
 *    相互参照検証を通過済みであり、ここから先の実装は「不正な定義」を考えなくてよい。
 *
 * 秘密情報はこのファイルに無い（SEC-04）。停止コマンドは定義に含まれるが、
 * ログ・画面へは出さない（SEC-05）。
 */
import { readFile } from 'node:fs/promises';

import type { RouterContext } from 'react-router';

import { sharedRouterContext } from './context-registry.ts';
import type { ManagedConfig } from './model.ts';
import {
  ManagedConfigError,
  parseManagedConfig,
} from './runtime-config.server.ts';

/** 再読込の結果。失敗しても旧設定で動き続けるため、例外ではなく値で返す。 */
export type ReloadResult =
  | { readonly ok: true; readonly config: ManagedConfig }
  | {
      readonly ok: false;
      /** 失敗理由。ログにだけ出し、画面には出さない（FR-07）。 */
      readonly reason: string;
      /** 項目ごとの指摘。`reason` に畳む前の一覧。 */
      readonly issues: readonly string[];
    };

/** 有効な設定の参照。呼ぶたびに最新の有効設定を返す。 */
export type ConfigStore = {
  /** 現在の有効設定。 */
  current(): ManagedConfig;
  /**
   * ファイルを読み直し、全体検証に成功したときだけ有効設定を差し替える。
   * 失敗時は旧設定を維持し、理由を返す。
   *
   * 複数の再読込が重なった場合は到着順に直列化し、後から始まった要求が必ず後で
   * 読み込む（古い内容が新しい内容を上書きしない）。
   */
  reload(): Promise<ReloadResult>;
};

/**
 * 設定ストアの load context キー。
 *
 * `globalThis` のスロットを唯一の情報源にする理由は
 * `app/lib/context-registry.ts` を参照。サーバーエントリと `build/server/index.js` は
 * 別のモジュールグラフになるため、モジュールスコープでキーを作ると実体が 2 つになり、
 * loader 側の `context.get` が失敗する。
 */
const configStoreContextSlot = '__powerManagerConfigStoreContext';

/** loader/action から設定ストアを参照するためのキー。 */
export const configStoreContext: RouterContext<ConfigStore> =
  sharedRouterContext<ConfigStore>(configStoreContextSlot);

/** `RouterContextProvider` のうち `requireConfigStore` が使う部分。テストで差し替えられるようにする。 */
type RouterContextProviderLike = { get: <T>(key: RouterContext<T>) => T };

/** load context から設定ストアを読む。未設定なら配線不整合だと分かるエラーにする。 */
export function requireConfigStore(
  context: RouterContextProviderLike,
): ConfigStore {
  try {
    return context.get(configStoreContext);
  } catch {
    throw new Error(
      '設定ストアが load context にありません（server/app.ts の createLoadContext を経由していません）',
    );
  }
}

/**
 * JSON を読み取って全体検証する。ファイルの読込み失敗も `ManagedConfigError` に畳む。
 *
 * 読込みの失敗（存在しない・権限なし・ディレクトリ）は設定の不備として扱う。
 * `fs` の例外メッセージはパスや環境依存の文言を含むため、種別だけを残す。
 */
async function loadFile(configPath: string): Promise<ManagedConfig> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ManagedConfigError([
      code === 'ENOENT'
        ? '設定ファイルが見つかりません'
        : code === 'EACCES'
          ? '設定ファイルを読み取る権限がありません'
          : '設定ファイルを読み取れませんでした',
    ]);
  }

  let parsed: unknown;
  try {
    // BOM 付きのファイルは運用者が用意しうる。JSON.parse は BOM を拒否するため落とす。
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    // パースエラーのメッセージは位置情報と入力の断片を含む。そのままログへ流さない。
    throw new ManagedConfigError(['JSON として解釈できません']);
  }

  return parseManagedConfig(parsed);
}

/**
 * 設定ストアを作る。
 *
 * `initial` は起動時に検証済みの設定である（`server/startup.ts` が起動時検証を通過した
 * 値を渡す）。したがって「まだ読んでいない」状態を持たなくてよい。
 *
 * `load` はテストから差し替えられるように引数で受ける。
 */
export function createConfigStore(
  configPath: string,
  initial: ManagedConfig,
  load: (configPath: string) => Promise<ManagedConfig> = loadFile,
): ConfigStore {
  let active: ManagedConfig = initial;

  /**
   * 直列化用の待ち行列の末尾。
   *
   * 再読込は「読込み → 検証 → 差し替え」の間に `await` を挟むため、2 本が同時に走ると
   * 先に読み込んだ古い内容が後に完了して新しい内容を上書きし得る。画面からの要求は
   * 通常 1 本だが、複数タブや二重送信で重なり得るため、到着順に 1 本ずつ処理する。
   * 待ち行列は処理が終わった時点で `null` に戻し、待ち手がいなければ何も保持しない。
   */
  let queue: Promise<unknown> | null = null;

  const runReload = async (): Promise<ReloadResult> => {
    let candidate: ManagedConfig;
    try {
      candidate = await load(configPath);
    } catch (error) {
      const issues =
        error instanceof ManagedConfigError
          ? error.issues
          : ['設定を読み込めませんでした'];
      // 非 ManagedConfigError の例外メッセージは入力の断片を含み得るため、
      // そのままログへ流さない（SEC-05, チケット 5859 のテストが検出）。
      return {
        ok: false,
        reason:
          error instanceof ManagedConfigError
            ? error.message
            : '設定の再読込に失敗しました',
        issues,
      };
    }

    // ここに到達した候補は全体検証を通過している。差し替えは 1 つの代入で完結するため、
    // 参照側から「一部だけ新しい定義」が見える状態は存在しない。
    active = candidate;
    return { ok: true, config: candidate };
  };

  return {
    current: () => active,

    reload(): Promise<ReloadResult> {
      const previous = queue ?? Promise.resolve();
      // 失敗を待ち行列に伝播させない（次の再読込は必ず実行する）。
      const next = previous.then(runReload, runReload);
      const tail = next.then(
        () => undefined,
        () => undefined,
      );
      queue = tail;
      // 待っている要求が無くなったら参照を手放す（モジュール寿命まで鎖を伸ばさない）。
      void tail.then(() => {
        if (queue === tail) queue = null;
      });
      return next;
    },
  };
}

/**
 * 起動時に設定ファイルを読み、全体検証した結果を返す。
 *
 * 起動時の失敗は `server/startup.ts` が終了コード 78 の対象として扱う（FR-08, NFR-05）。
 */
export function loadManagedConfigForStartup(
  configPath: string,
): Promise<ManagedConfig> {
  return loadFile(configPath);
}
