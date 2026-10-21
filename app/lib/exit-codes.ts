/**
 * プロセスの終了コード。
 *
 * `nix/module.nix` の `RestartPreventExitStatus` が `78` を再起動抑止に使い、
 * `scripts/smoke.mjs` も同じ値を期待する。3 箇所に数字を書くと片方だけ変えたときに
 * 気付けないため、ここを唯一の定義にする。
 */

/**
 * 設定不備を表す sysexits.h の EX_CONFIG。
 *
 * 環境変数・設定 JSON の検証失敗と、待受アドレスの不備（使用中・権限なし・不正）に使う。
 * いずれも設定変更でしか解消できず、`Restart=on-failure` で再起動しても同じ失敗を
 * 繰り返すため、再起動抑止の対象にする（NFR-05, NFR-06）。
 */
export const configurationErrorExitCode = 78;
