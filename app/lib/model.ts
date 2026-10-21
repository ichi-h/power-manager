/**
 * ドメイン型。
 *
 * サーバー・グループ・予約という管理対象の定義と、電源操作・対象種別・繰り返しの語彙を
 * ここに集約する。設定 JSON のスキーマ（`app/lib/runtime-config.server.ts`）と、
 * 画面・操作・予約の各実装はこの型に合わせる。
 *
 * 値の集合は実行時にも必要になる（スキーマの列挙、結果表示の分岐）ため、
 * `as const` の配列を唯一の定義とし、型はそこから導く。型と配列を別々に書くと
 * 片方だけ増やしたときに気付けない。
 */

/** 電源操作の種別（FR-04, FR-05）。 */
export const powerOperations = ['wake', 'shutdown'] as const;

/** 電源操作の種別。 */
export type PowerOperation = (typeof powerOperations)[number];

/** 曜日（FR-12）。`days` の重複・空配列は検証で拒否する。 */
export const weekdays = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;

/** 曜日。 */
export type Weekday = (typeof weekdays)[number];

/** サーバーの死活状態（FR-03）。未取得の初期値は `unknown`。 */
export const serverStates = ['online', 'offline', 'unknown'] as const;

/** サーバーの死活状態（FR-03）。 */
export type ServerState = (typeof serverStates)[number];

/** 操作対象の種別（FR-12）。 */
export const targetTypes = ['server', 'group'] as const;

/** 操作対象の種別。 */
export type TargetType = (typeof targetTypes)[number];

/**
 * 操作対象（サーバー 1 台またはグループ 1 つ）。
 *
 * `type` で判別できる形にし、「サーバーとグループの両方」「どちらでもない」という
 * 曖昧な指定を型で作れなくする（FR-09）。`id` が定義済みであることは、スキーマ検証の
 * 後に相互参照検証で確かめる。
 */
export type Target =
  | { readonly type: 'server'; readonly id: string }
  | { readonly type: 'group'; readonly id: string };

/** 繰り返しの種別（FR-12）。 */
export const repeatKinds = ['daily', 'weekly'] as const;

/** 繰り返しの種別。 */
export type RepeatKind = (typeof repeatKinds)[number];

/**
 * 予約の繰り返し。`time` は `HH:MM` の 24 時間表記（Asia/Tokyo 固定, CON-08）。
 * `weekly` だけが `days` を持つ。
 */
export type Repeat =
  | { readonly kind: 'daily'; readonly time: string }
  | {
      readonly kind: 'weekly';
      readonly days: readonly Weekday[];
      readonly time: string;
    };

/**
 * Wake-on-LAN の送信先。
 *
 * `broadcastAddress` は IPv4 のみ。既定値は `255.255.255.255`、`port` は `9`。
 */
export type WolSettings = {
  readonly broadcastAddress: string;
  readonly port: number;
};

/**
 * SSH 停止の接続先と実行コマンド。
 *
 * 秘密情報は持たない（SEC-04）。認証は起動時設定の鍵ファイルで行う。
 * `shutdownCommand` はログ・画面へ出さない（SEC-05）。
 */
export type SshSettings = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly shutdownCommand: string;
};

/** 管理対象のサーバー（`docs/operations.md` 2.1）。 */
export type Server = {
  /** `servers` 内で一意な識別子。URL とログに現れる。 */
  readonly id: string;
  /** 画面表示名。 */
  readonly name: string;
  /** 所属グループの識別子。空配列可。 */
  readonly groups: readonly string[];
  /** `XX:XX:XX:XX:XX:XX` 形式の MAC アドレス。 */
  readonly macAddress: string;
  readonly wol: WolSettings;
  readonly ssh: SshSettings;
};

/** 管理対象のグループ（`docs/operations.md` 2.2）。1 台以上のサーバーを持つ。 */
export type Group = {
  /** `groups` 内で一意な識別子。 */
  readonly id: string;
  /** 画面表示名。一括操作のボタンのラベルに使う。 */
  readonly name: string;
};

/** 予約（`docs/operations.md` 2.3）。 */
export type Schedule = {
  /** `schedules` 内で一意な識別子。ログと「最近の実行」のキー。 */
  readonly id: string;
  /** 画面表示名。 */
  readonly name: string;
  /** `false` の予約は次回時刻を計算せず発火しない。 */
  readonly enabled: boolean;
  readonly target: Target;
  readonly operation: PowerOperation;
  readonly repeat: Repeat;
};

/**
 * 検証済みの管理対象定義（設定 JSON の中身, CON-07）。
 *
 * `version` を `2` に固定して持つ。v1 形式との後方互換はない（FR-09）。
 * この型を持つ値は、集合内の一意性と相互参照の検証を通過済みである。
 */
export type ManagedConfig = {
  readonly version: 2;
  readonly servers: readonly Server[];
  readonly groups: readonly Group[];
  readonly schedules: readonly Schedule[];
};
