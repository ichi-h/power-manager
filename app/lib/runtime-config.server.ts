/**
 * 管理対象 JSON（設定 JSON）のスキーマと検証。
 *
 * 環境変数のスキーマ（`app/lib/config.server.ts`）とは入力も寿命も違うため分ける。
 * 環境変数は起動時に 1 度だけ読むが、この設定 JSON は稼働中に再読込される（FR-08）。
 *
 * 検証は 2 段に分ける。
 *
 * 1. Zod のスキーマ（`managedConfigSchema`）で、形式・型・必須・既定値を見る。
 * 2. 集合内の一意性と相互参照（`collectCrossFieldIssues`）を見る。
 *
 * Zod の `superRefine` にまとめないのは、2 段目が「他の項目を参照する」検証であり、
 * 個々の項目の検証と失敗したときの直し方が違うためである。両方の指摘をまとめて返す。
 *
 * 未知項目はすべての階層で拒否する（`strictObject`）。設定ファイルへ後から足した項目が
 * 黙って無視されると、利用者は「設定したのに効かない」状態に気付けない（FR-09, SEC-06）。
 */
import { z } from "zod";

import {
  powerOperations,
  repeatKinds,
  targetTypes,
  weekdays,
  type ManagedConfig,
  type RepeatKind,
} from "./model.ts";

/** 検証メッセージ。項目名は指摘の path に出るため、ここでは理由だけを書く。 */
const messages = {
  required: "必須です",
  stringType: "文字列で指定してください",
  numberType: "数値で指定してください",
  booleanType: "真偽値で指定してください",
  arrayType: "配列で指定してください",
  objectType: "オブジェクトで指定してください",
  empty: "空にできません",
  surroundingWhitespace: "前後に空白を含めないでください",
  unknownKey: "未知の項目です",
  version: "2 を指定してください（v1 形式は未対応です）",
  operation: `${powerOperations.join(" か ")} を指定してください`,
  targetType: `type に ${targetTypes.join(" か ")} を指定し、id を 1 つだけ持たせてください`,
  repeatKind: `kind に ${repeatKinds.join(" か ")} を指定してください（weekly は days が必要です）`,
  macAddress: "MAC アドレスの形式（XX:XX:XX:XX:XX:XX）で指定してください",
  ipv4: "IPv4 アドレス（例 192.168.1.255）で指定してください",
  port: "1 から 65535 の整数で指定してください",
  time: "HH:MM の 24 時間表記で指定してください",
  integer: "整数で指定してください",
} as const;

/** 欠落を「必須」、型違いを「型が違う」として区別する。 */
function typeMessage(expected: string) {
  return (issue: { input?: unknown }): string =>
    issue.input === undefined ? messages.required : expected;
}

/**
 * オブジェクト位置の検証メッセージ。
 *
 * `strictObject` の `error` は未知キーとオブジェクト以外の入力の両方に使われるため、
 * 指摘の種別で出し分ける。型違いに「未知の項目です」と出すと、利用者は直す場所を誤る
 * （FR-09）。
 */
function objectMessage(issue: { code?: string; input?: unknown }): string {
  if (issue.code === "unrecognized_keys") return messages.unknownKey;
  return issue.input === undefined ? messages.required : messages.objectType;
}

/** 空文字と前後の空白を拒否する文字列。 */
const stringValue = z
  .string({ error: typeMessage(messages.stringType) })
  .min(1, { message: messages.empty })
  .refine((value) => value === value.trim(), {
    message: messages.surroundingWhitespace,
  });

/** ポート番号。 */
const portValue = z
  .number({ error: typeMessage(messages.numberType) })
  .int({ message: messages.integer })
  .min(1, { message: messages.port })
  .max(65535, { message: messages.port });

/** `XX:XX:XX:XX:XX:XX` 形式の MAC アドレス。 */
const macAddressValue = stringValue.regex(
  /^[\dA-Fa-f]{2}(?::[\dA-Fa-f]{2}){5}$/,
  { message: messages.macAddress },
);

/** 0–255 の 4 オクテットで書いた IPv4 アドレス。 */
const ipv4Value = stringValue.regex(
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
  { message: messages.ipv4 },
);

/** `HH:MM` の 24 時間表記。 */
const timeValue = stringValue.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, {
  message: messages.time,
});

/** 曜日。値の集合は `app/lib/model.ts` を唯一の定義にする。 */
const weekdayValue = z.enum(weekdays, {
  error: "mon/tue/wed/thu/fri/sat/sun のいずれかで指定してください",
});

/** 文字列の配列。 */
function stringArrayValue() {
  return z.array(stringValue, {
    error: typeMessage(messages.arrayType),
  });
}

/**
 * Wake-on-LAN の設定。省略時は `{}` として扱い、項目ごとの既定値を適用する。
 * `prefault` を使うのは、`wol: {}` と `wol` の省略を同じ結果にするためである。
 */
const wolSchema = z
  .strictObject(
    {
      broadcastAddress: ipv4Value.default("255.255.255.255"),
      port: portValue.default(9),
    },
    { error: objectMessage },
  )
  .prefault({});

/** SSH 停止の設定。接続先は必須で、秘密情報は持たない（SEC-04）。 */
const sshSchema = z.strictObject(
  {
    host: stringValue,
    port: portValue.default(22),
    user: stringValue,
    shutdownCommand: stringValue,
  },
  { error: objectMessage },
);

/** サーバー 1 台（`docs/operations.md` 2.1）。 */
const serverSchema = z.strictObject(
  {
    id: stringValue,
    name: stringValue,
    groups: stringArrayValue().default([]),
    macAddress: macAddressValue,
    wol: wolSchema,
    ssh: sshSchema,
  },
  { error: objectMessage },
);

/** グループ 1 つ（`docs/operations.md` 2.2）。メンバーはサーバー側が持つ。 */
const groupSchema = z.strictObject(
  {
    id: stringValue,
    name: stringValue,
  },
  { error: objectMessage },
);

/**
 * 予約の対象。「サーバー 1 台」と「グループ 1 つ」を `type` で判別できる形に固定する
 * （FR-09）。種類の語彙は `app/lib/model.ts` の `targetTypes` を唯一の定義にする。
 */
const targetSchema = z.strictObject(
  {
    type: z.enum(targetTypes, { error: typeMessage(messages.targetType) }),
    id: stringValue,
  },
  { error: objectMessage },
);

/**
 * 繰り返し（FR-12）。`days` は `weekly` だけが持つ。
 *
 * `satisfies Record<RepeatKind, ...>` により、`app/lib/model.ts` の `repeatKinds` に
 * 種別を足したとき、ここへスキーマを足し忘れると型検査で落ちる。
 */
const repeatSchemas = {
  daily: z.strictObject(
    { kind: z.literal("daily"), time: timeValue },
    { error: objectMessage },
  ),
  weekly: z.strictObject(
    {
      kind: z.literal("weekly"),
      days: z.array(weekdayValue, { error: typeMessage(messages.arrayType) }),
      time: timeValue,
    },
    { error: objectMessage },
  ),
} satisfies Record<RepeatKind, z.ZodType>;

const repeatSchema = z.discriminatedUnion("kind", [repeatSchemas.daily, repeatSchemas.weekly], {
  error: (issue) =>
    issue.input === undefined ? messages.required : messages.repeatKind,
});

/** 予約 1 件（`docs/operations.md` 2.3）。 */
const scheduleSchema = z.strictObject(
  {
    id: stringValue,
    name: stringValue,
    enabled: z.boolean({ error: typeMessage(messages.booleanType) }),
    target: targetSchema,
    operation: z.enum(powerOperations, { error: messages.operation }),
    repeat: repeatSchema,
  },
  { error: objectMessage },
);

/**
 * 設定 JSON の全体。ルートの `version` は `2` 固定で、3 つの配列を必須に持つ。
 * `servers` は空を許す（全サーバー削除は利用者の判断であり、グループの空だけを拒否する）。
 */
export const managedConfigSchema = z.strictObject(
  {
    version: z.literal(2, { error: typeMessage(messages.version) }),
    servers: z.array(serverSchema, { error: typeMessage(messages.arrayType) }),
    groups: z.array(groupSchema, { error: typeMessage(messages.arrayType) }),
    schedules: z.array(scheduleSchema, { error: typeMessage(messages.arrayType) }),
  },
  { error: objectMessage },
);

/**
 * 集合内の一意性と相互参照を検証する（FR-09）。
 *
 * スキーマ検証を通った定義だけを渡す前提で、参照先の存在と集合内の一意性を見る。
 * スキーマ段階では「他の項目を参照する」検証ができないため、ここで第二段として行う。
 * 見つかった指摘はすべて集めて返す（1 件ずつ直させるより、1 度で全部見せる方がよい）。
 */
export function collectCrossFieldIssues(config: ManagedConfig): string[] {
  const issues: string[] = [];

  /** 集合内の重複を見つける。 */
  function checkUniqueIds(collection: string, items: readonly { id: string }[]): void {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.id)) {
        issues.push(`${collection}.${index}.id: 識別子 ${item.id} が重複しています`);
      }
      seen.add(item.id);
    }
  }

  checkUniqueIds("servers", config.servers);
  checkUniqueIds("groups", config.groups);
  checkUniqueIds("schedules", config.schedules);

  const groupIds = new Set(config.groups.map((group) => group.id));
  const serverIds = new Set(config.servers.map((server) => server.id));

  // サーバーが参照するグループは明示定義されていなければならない（FR-11）。
  for (const [index, server] of config.servers.entries()) {
    for (const [groupIndex, groupId] of server.groups.entries()) {
      if (!groupIds.has(groupId)) {
        issues.push(
          `servers.${index}.groups.${groupIndex}: グループ ${groupId} が定義されていません`,
        );
      }
    }
  }

  // サーバーを持たないグループはエラー（FR-11）。一括操作の対象が空になる定義を作らせない。
  for (const [index, group] of config.groups.entries()) {
    const belongs = config.servers.some((server) => server.groups.includes(group.id));
    if (!belongs) {
      issues.push(`groups.${index}: グループ ${group.id} に所属するサーバーがありません`);
    }
  }

  // 予約の対象は定義済みのサーバーまたはグループでなければならない（FR-09）。
  for (const [index, schedule] of config.schedules.entries()) {
    const { target } = schedule;
    const defined = target.type === "server" ? serverIds.has(target.id) : groupIds.has(target.id);
    if (!defined) {
      issues.push(
        `schedules.${index}.target.id: ${target.type} ${target.id} が定義されていません`,
      );
    }

    // 曜日の空配列・重複は予約として意味を持たないため拒否する（FR-12）。
    if (schedule.repeat.kind === "weekly") {
      const { days } = schedule.repeat;
      if (days.length === 0) {
        issues.push(`schedules.${index}.repeat.days: 曜日を 1 つ以上指定してください`);
      }
      if (new Set(days).size !== days.length) {
        issues.push(`schedules.${index}.repeat.days: 曜日が重複しています`);
      }
    }
  }

  return issues;
}

/** 検証に失敗した理由。項目の path と理由の組を文字列で持つ。 */
export class ManagedConfigError extends Error {
  /** 指摘の一覧（`servers.0.macAddress: MAC アドレスの形式...` の形）。 */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`管理対象の設定が不正です（${issues.join(" / ")}）`);
    this.name = "ManagedConfigError";
    this.issues = issues;
  }
}

/** Zod の指摘を、項目の path と理由だけの文字列にする。 */
function describeIssues(error: z.ZodError): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".");
    const description = path === "" ? issue.message : `${path}: ${issue.message}`;
    if (seen.has(description)) continue;
    seen.add(description);
    issues.push(description);
  }

  return issues;
}

/**
 * 文字列を検証し、`ManagedConfig` を返す。失敗時は `ManagedConfigError` を投げる。
 *
 * 入力は `JSON.parse` の結果を想定している（`unknown`）。ファイルの読込みと
 * JSON のパースは呼び出し側（`app/lib/config-store.server.ts`）の責務である。
 */
export function parseManagedConfig(input: unknown): ManagedConfig {
  const parsed = managedConfigSchema.safeParse(input);
  if (!parsed.success) throw new ManagedConfigError(describeIssues(parsed.error));

  const crossFieldIssues = collectCrossFieldIssues(parsed.data);
  if (crossFieldIssues.length > 0) throw new ManagedConfigError(crossFieldIssues);

  return parsed.data;
}
