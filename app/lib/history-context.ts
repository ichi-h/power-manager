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

/**
 * 「最近の実行」の 1 行分のデータ。
 *
 * `seq` はリングバッファが保持順に振る単調増加の連番である。画面で行を一意に識別する
 * （`key`）ために使い、表示項目としては出さない（FR-13）。同一対象を同一ミリ秒に
 * 複数操作しても衝突しない。
 */
export type HistoryRecord = PowerOperationRecord & { readonly seq: number };

/** `/api/history` が返す本文。新しい順に並ぶ直近の実行結果だけを持つ。 */
export type HistoryResponse = {
  readonly records: ReadonlyArray<HistoryRecord>;
};
