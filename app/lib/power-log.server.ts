/**
 * 電源操作の構造化ログ（NFR-10, `docs/architecture.md` 7.1）。
 *
 * `power_operation` / `schedule_run` / `schedule_skip` / `config_reload` の 1 行
 * 1 JSON を標準出力へ出す。`started` / `startup_failed` / `shutdown` /
 * `request_failed` はそれぞれ `server/index.ts` / `server/startup.ts` /
 * `server/log.ts` が出すため、ここでは扱わない。
 *
 * 秘密情報（パスワード・ハッシュ・秘密鍵・停止コマンドの内容）は出さない（SEC-05）。
 * このモジュールが出すのは「設定に含まれる値」ではなく、対象 ID・操作種別・成否・
 * 失敗分類・予約 ID・スキップ理由だけである。
 */
import type { PowerOperationRecord } from "./power.server.ts";

/**
 * 電源操作の結果を 1 行 JSON で標準出力へ出す（NFR-10）。
 *
 * イベント名は実行の出自で切り替える。手動（単体・一括）は `power_operation`、予約は
 * `schedule_run`。スキップ（busy・missed_schedule）は予約でのみ結果を残すため
 * `schedule_skip` とする。手動操作の busy は「拒否」であり、呼び出し側は 409 系の
 * 応答へ読み替える（FR-06）。一括操作の `group` フィールドは `power_operation` にだけ
 * 付ける。
 */
export function logPowerOperation(
  record: PowerOperationRecord,
  event:
    "power_operation" | "schedule_run" | "schedule_skip" = "power_operation",
): void {
  console.log(
    JSON.stringify({
      event,
      serverId: record.target.type === "server" ? record.target.id : undefined,
      groupId: record.target.type === "group" ? record.target.id : undefined,
      operation: record.operation,
      result: record.result,
      code: record.code,
      ...(record.scheduleId === undefined
        ? {}
        : { scheduleId: record.scheduleId }),
      ...(record.group === undefined ? {} : { group: record.group }),
    }),
  );
}

/**
 * 予約のスキップを 1 行 JSON で標準出力へ出す（NFR-12）。
 *
 * `code` は `busy` / `missed_schedule` のいずれか。理由の詳細（内部メッセージ）は
 * 載せない（SEC-05）。
 */
export function logScheduleSkip(
  scheduleId: string,
  target: { readonly type: string; readonly id: string },
  code: "busy" | "missed_schedule",
): void {
  console.log(
    JSON.stringify({
      event: "schedule_skip",
      scheduleId,
      target: { type: target.type, id: target.id },
      code,
    }),
  );
}
