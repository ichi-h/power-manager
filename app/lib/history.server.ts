/**
 * 実行結果のリングバッファ（FR-13, `docs/architecture.md` 6.6）。
 *
 * メモリ上に直近 `capacity` 件（実運用は 100 件）を保持する。上限を超えたら最古の
 * 要素から破棄する。プロセス再起動で空になることを許容し（NFR-02）、恒久記録は
 * journald への 1 行 JSON ログ（`app/lib/power-log.server.ts`）に委ねる。
 *
 * このモジュールは保持のみを担い、記録の契機（単体・一括・予約の実行経路）は
 * `app/lib/power.server.ts` の `onRecord` フックから渡ってくる。画面（「最近の実行」欄）
 * への読み出しは `recent()` を使う。保持の破棄は最古から、読み出しは最新から順に返す。
 *
 * 件数と配列はどちらも 1 つのオブジェクトへ閉じ、操作ごとにアトミックに更新する
 * （ awaits を挟まないため、イベントループ上で分割されない）。配列を都度作るため、
 * `recent()` の呼び出し側が参照を共有して破棄済みの要素を見ることはない。
 *
 * 要素は `push` 時に `Object.freeze` で不変にする。`recent()` は `[...records]` の
 * 浅いコピー（配列のコピー）で返すが、要素オブジェクトは凍結済みのため、
 * 呼び出し側が要素フィールドを書き換えても内部の保持へ波及しない。
 */
import { createContext, type RouterContext } from 'react-router';

import type { PowerOperationRecord } from './power.server.ts';

/** 保持件数の既定値（FR-13）。環境変数などで変える設定項目は持たない。 */
export const historyCapacity = 100;

/**
 * 実行結果のリングバッファ。
 *
 * `push` は `app/lib/power.server.ts` の `onRecord` から呼ぶ。`recent` は画面の loader
 * （「最近の実行」欄）から呼ぶ。いずれも同期で、失敗しない。
 */
export type OperationHistory = {
  /** 実行結果を 1 件追加する。上限を超えたら最古の 1 件を破棄する。 */
  push(record: PowerOperationRecord): void;
  /** 保持している実行結果を新しい順で返す。保持していないときは空配列。 */
  recent(): readonly PowerOperationRecord[];
};

/**
 * リングバッファを作る。
 *
 * `capacity` を引数で受けられるのはテストのためだけである（実運用は
 * `historyCapacity` 固定）。`0` 以下は保持しない意味として扱い、負数の件数で
 * `recent` が失敗する形にはしない。
 */
export function createOperationHistory(
  capacity: number = historyCapacity,
): OperationHistory {
  const records: Array<PowerOperationRecord> = [];

  return {
    push(record: PowerOperationRecord) {
      // 保持する要素は不変とする。呼び出し側が渡したオブジェクトを後から書き換えても、
      // バッファ内の保持へは波及しない。
      records.push(Object.freeze(record));
      // push は必ず 1 件だけ増やすため、超過時の破棄は固定の 1 件で足りる。
      if (records.length > capacity)
        records.splice(0, records.length - capacity);
    },

    recent() {
      // 読み出し側で並べ替え・破棄されないよう、コピーを渡す。要素は push 時に
      // `Object.freeze` で不変にしているため、要素フィールドの書き換えも保持へ
      // 波及しない（浅いコピーで足りる）。
      return [...records].reverse();
    },
  };
}

/**
 * リングバッファの load context キー。
 *
 * `configStoreContext`（`app/lib/config-store.server.ts`）と同じ理由で `globalThis` の
 * スロットを唯一の情報源にする。サーバーエントリと `build/server/index.js` は別の
 * モジュールグラフになるため、モジュールスコープでキーを作ると実体が 2 つになり、
 * loader 側の `context.get` が失敗する。
 */
const historyContextSlot = '__powerManagerHistoryContext';

type HistoryContextRegistry = {
  [historyContextSlot]?: RouterContext<OperationHistory>;
};

const historyContextRegistry = globalThis as unknown as HistoryContextRegistry;

/** loader/action からリングバッファを参照するためのキー。`server/app.ts` が実体を設定する。 */
export const historyContext: RouterContext<OperationHistory> =
  (historyContextRegistry[historyContextSlot] ??=
    createContext<OperationHistory>());

/** `RouterContextProvider` のうち `requireHistory` が使う部分。テストで差し替えられるようにする。 */
type RouterContextProviderLike = { get: <T>(key: RouterContext<T>) => T };

/** load context からリングバッファを読む。未設定なら配線不整合だと分かるエラーにする。 */
export function requireHistory(
  context: RouterContextProviderLike,
): OperationHistory {
  try {
    return context.get(historyContext);
  } catch (cause) {
    throw new Error(
      'リングバッファが load context にありません（server/app.ts の createLoadContext を経由していません）',
      { cause },
    );
  }
}
