/**
 * 停止の確認に使う固定の値（FR-05, FR-11, SEC-07）。
 *
 * 確認ページ（`app/routes/confirm.tsx`）の送信ボタンだけが `confirmedIntent` にこの値を
 * 載せる。一覧画面の action は「停止の要求にこの値があるか」で確認済みを判定し、
 * 無い要求は操作せず確認ページへ送り返す。
 *
 * 確認を「画面のダイアログ」ではなく「画面の遷移」にしたのは、スクリプトが無効な環境でも
 * 確認を 1 段挟めるようにするためである（NFR-09）。
 */
export const CONFIRM_INTENT = 'confirm-shutdown';
