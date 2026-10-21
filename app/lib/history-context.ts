/**
 * 「最近の実行」の取得結果の型（FR-13）。
 *
 * `/api/history` の応答と、その応答を読む画面の両方が参照する。画面（client）からも
 * 参照されるため、リングバッファの実装（`app/lib/history.server.ts`）には依存せず、
 * レコードの型だけを型として取り込む（実行時には消える）。
 *
 * ここに置くのは型だけである。リングバッファの実体と読み出しは server-only 側に閉じる。
 */
import type { PowerOperationRecord } from './power.server.ts';

/** `/api/history` が返す本文。新しい順に並ぶ直近の実行結果だけを持つ。 */
export type HistoryResponse = {
  readonly records: ReadonlyArray<PowerOperationRecord>;
};
