# power-manager 運用設計

本書は設定・配備・CI・テストの実務を定義する。要件は [要件定義](requirements.md)、技術選定と構成は [アーキテクチャ設計](architecture.md)、認証と秘密情報の扱いは [セキュリティ設計](security.md) を参照する。

## 1. 実行時設定（環境変数）

アプリケーションは CLI 引数を受け取らない。次の環境変数がすべて存在し妥当でなければ起動に失敗する（NFR-06）。

| 環境変数                             | 用途                                          | 検証                                                                       |
| ------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------- |
| `POWER_MANAGER_CONFIG_PATH`          | 管理対象 JSON の絶対パス                      | 絶対パス、前後の空白なし、`..`・`//`・末尾 `/` を含まない正規形、NUL なし   |
| `POWER_MANAGER_PORT`                 | loopback HTTP の待受ポート                    | `1`–`65535` の 10 進整数（先頭ゼロ・符号・小数・空白なし）                 |
| `POWER_MANAGER_PUBLIC_ORIGIN`        | CSRF 検証に使う外部 Origin                    | HTTPS、開発時のみ `http://localhost[:port]`、パス・資格情報・`*` を含まない |
| `POWER_MANAGER_AUTH_USERNAME`        | Basic 認証のユーザー名                        | `[A-Za-z0-9._-]` のみ、64 文字以内、前後の空白なし                          |
| `POWER_MANAGER_AUTH_PASSWORD_HASH`   | Argon2id パスワードハッシュ                   | `$argon2id$v=..$m=..,t=..,p=..$salt$hash`、パラメータは下表の範囲           |
| `POWER_MANAGER_SSH_IDENTITY_FILE`    | SSH 専用秘密鍵の絶対パス                      | 絶対パス、前後の空白なし、正規形、NUL なし                                  |
| `POWER_MANAGER_SSH_KNOWN_HOSTS_FILE` | SSH 接続先を検証する `known_hosts` の絶対パス | 絶対パス、前後の空白なし、正規形、NUL なし                                  |
| `NODE_ENV`                           | 実行モード                                    | `production` / `development` / `test`。省略時は `production`               |

値は前後の空白を落として解釈しない。`FOO=bar ` のような行末空白は設定ミスとして起動時に拒否する。

`NODE_ENV` は 7 つの `POWER_MANAGER_*` とは別扱いで、未設定なら `production` とみなす。本番では明示しなくてよい。`NODE_ENV=production`（および未設定）では `POWER_MANAGER_PUBLIC_ORIGIN` に `http://localhost` も含めて HTTP の URL を指定できない。ローカル開発でのみ `development` を指定する（[セキュリティ設計](security.md) 3.2）。

パスワードハッシュのパラメータ範囲:

| パラメータ | 範囲            | 理由                                                     |
| ---------- | --------------- | -------------------------------------------------------- |
| `m`        | 19456–262144    | 弱すぎる設定は総当たり可能、過大な指定は認証毎にメモリを枯渇させる |
| `t`        | 2–10            | 同上                                                     |
| `p`        | 1–4             | 同上                                                     |

ソルトは 16 バイト以上、ハッシュは 32 バイト以上を要求する。`node-argon2` は `m,p,t` の順で出力するが、検証はパラメータの順序に依存しない。

環境変数を変更した場合は systemd サービスの再起動が必要である。再読込操作の対象は管理対象 JSON のみ（NFR-13）。

環境変数ファイルの例:

```ini
POWER_MANAGER_CONFIG_PATH=/etc/power-manager/config.json
POWER_MANAGER_PORT=8080
POWER_MANAGER_PUBLIC_ORIGIN=https://power.example.ts.net
POWER_MANAGER_AUTH_USERNAME=admin
POWER_MANAGER_AUTH_PASSWORD_HASH=$argon2id$...
POWER_MANAGER_SSH_IDENTITY_FILE=/run/secrets/power-manager/id_ed25519
POWER_MANAGER_SSH_KNOWN_HOSTS_FILE=/etc/power-manager/known_hosts
# 本番では不要（未設定なら production として扱う）
# NODE_ENV=production
```

パスワードハッシュは運用者が生成する。アプリケーションは生成機能を持たない。

```sh
# nix run nixpkgs#argon2 などでハッシュを生成する
echo -n 'パスワード' | argon2 "$(head -c16 /dev/urandom | base64)" -id -e
```

## 2. 管理対象設定 JSON

ルートに必須の `version: 2` を持つ。`servers`、`groups`、`schedules` の 3 つの配列を持つ。検証は厳格に行い、未知の項目、型不一致、空の必須項目、重複 ID、未定義グループ参照、不正な MAC アドレス、範囲外のポート、不正な予約を拒否する（FR-09）。MAC アドレスと接続先ホスト・ポートは、利用者が事前に把握して記述する（CON-03）。

v1 形式との後方互換は持たない（`version: 1` は検証エラーになる）。

```json
{
  "version": 2,
  "servers": [
    {
      "id": "nas",
      "name": "NAS",
      "groups": ["storage"],
      "macAddress": "00:11:22:33:44:55",
      "wol": {
        "broadcastAddress": "192.168.1.255",
        "port": 9
      },
      "ssh": {
        "host": "nas.example.internal",
        "port": 2222,
        "user": "power-manager",
        "shutdownCommand": "sudo systemctl poweroff"
      }
    },
    {
      "id": "test-01",
      "name": "検証機 01",
      "groups": ["test"],
      "macAddress": "00:11:22:33:44:66",
      "ssh": {
        "host": "test-01.example.internal",
        "user": "power-manager",
        "shutdownCommand": "sudo systemctl poweroff"
      }
    }
  ],
  "groups": [
    { "id": "storage", "name": "ストレージ" },
    { "id": "test", "name": "検証機" }
  ],
  "schedules": [
    {
      "id": "test-night-shutdown",
      "name": "検証機 夜間停止",
      "enabled": true,
      "target": { "type": "group", "id": "test" },
      "operation": "shutdown",
      "repeat": { "kind": "daily", "time": "23:30" }
    },
    {
      "id": "storage-morning-wake",
      "name": "ストレージ 平日朝起動",
      "enabled": true,
      "target": { "type": "server", "id": "nas" },
      "operation": "wake",
      "repeat": { "kind": "weekly", "days": ["mon", "tue", "wed", "thu", "fri"], "time": "07:30" }
    }
  ]
}
```

### 2.1 サーバー

| 項目                   | 必須   | 既定値            | 備考                                        |
| ---------------------- | ------ | ----------------- | ------------------------------------------- |
| `id`                   | はい   | —                 | `servers` 内で一意。URL とログに現れる      |
| `name`                 | はい   | —                 | 画面表示名                                  |
| `groups`               | いいえ | `[]`              | 所属グループ ID の配列。未定義 ID は検証エラー |
| `macAddress`           | はい   | —                 | `XX:XX:XX:XX:XX:XX` 形式                    |
| `wol.broadcastAddress` | いいえ | `255.255.255.255` | IPv4 のみ                                   |
| `wol.port`             | いいえ | `9`               | `1`–`65535`                                 |
| `ssh.host`             | はい   | —                 | ホスト名または IP アドレス                  |
| `ssh.port`             | いいえ | `22`              | `1`–`65535`                                 |
| `ssh.user`             | はい   | —                 | 管理専用ユーザー                            |
| `ssh.shutdownCommand`  | はい   | —                 | 対象側 `sudoers` で許可される範囲           |

### 2.2 グループ

| 項目   | 必須 | 備考                                    |
| ------ | ---- | --------------------------------------- |
| `id`   | はい | `groups` 内で一意                       |
| `name` | はい | 画面表示名（一括ボタンのラベルに使う）  |

- グループは明示定義のみ。サーバーの `groups` が未定義 ID を指した場合は検証エラー（FR-09）。
- サーバーを持たないグループは検証エラーとする（FR-11）。
- サーバーは複数のグループに所属できる。一括操作の対象が重複しても、同一サーバーへの操作は 1 回だけ実行する（対象集合を ID で重複排除する）。
- サーバーの `groups` に同じグループ ID を 2 回書いた場合は検証エラー（`servers.<i>.groups.<j>: グループ <id> が重複しています`）。対象集合は ID で重複排除するため実行結果は変わらないが、所属の書き間違いである可能性が高いため、定義の誤りとして扱う。
- グループ ID に予約語は無い。`all` をグループ ID として定義できる（一括操作の要求は種別 `scopeKind`（`all` / `group`）と `scopeId` に分かれており、グループ ID の文字列と全台一括が衝突しない）。
- 「全サーバー」は定義不要の固定ボタンとして提供する（FR-11）。

### 2.3 予約

| 項目       | 必須 | 備考                                                          |
| ---------- | ---- | ------------------------------------------------------------- |
| `id`       | はい | `schedules` 内で一意。ログと「最近の実行」のキー              |
| `name`     | はい | 画面表示名                                                    |
| `enabled`  | はい | `false` の予約は次回時刻を計算せず発火しない                   |
| `target`   | はい | `{ "type": "server" \| "group", "id": "..." }`                |
| `operation`| はい | `"wake"` または `"shutdown"`                                  |
| `repeat`   | はい | `{ "kind": "daily", "time": "HH:MM" }` または `{ "kind": "weekly", "days": [...], "time": "HH:MM" }` |

- 単発（1 回だけの日時）は対象外。必要なら不要になった時点で `enabled: false` にするか、定義から削除する。
- `days` は `mon`/`tue`/`wed`/`thu`/`fri`/`sat`/`sun` の配列。重複と空配列は検証エラー。
- 時刻は `HH:MM` の 24 時間表記、Asia/Tokyo 固定（CON-08）。
- 予約は順序制御・待機を持たない。1 予約 = 1 操作 × 1 対象（FR-12）。

秘密情報はこのファイルに含めない（SEC-04）。`ssh.user` と停止コマンドは秘密ではないが、権限は対象側で最小化する（[セキュリティ設計](security.md) 5 章）。

定義ファイルは運用者が編集し、アプリケーションは読み取りのみを行う（CON-09）。画面からの追加・変更・削除は提供しない。

### 2.4 再読込の挙動

1. ファイルを読み、JSON としてパースする。
2. 候補設定を全体検証する（サーバー・グループ・予約の相互参照を含む）。
3. 検証成功時のみ有効設定を差し替える（原子的差し替え）。
4. スケジューラの次回実行時刻を新しい定義から再計算し、状態を差し替える。実行中の操作は中断しない（NFR-13）。
5. 失敗時は直前の有効設定とスケジューラ状態を維持し、結果種別（失敗）を画面に表示し、失敗理由をログに記録する。

起動時の検証に失敗した場合は HTTP サーバーを開始せず、終了コード `78` で終了する。待受アドレスが使えない場合（使用中・権限なし・不正）も同じ `78` に分類し、再起動ループを避ける。設定不備以外の例外（実装の不具合など）は再起動と失敗記録を優先し、`startup_failed`（`code: "operation_failed"`）を 1 行出して終了コード `1` で落ちる。

## 3. 開発

```sh
npm ci                 # 依存の導入（bun は使わない）
npm run dev            # react-router dev（Vite、127.0.0.1 で待受）
npm run typecheck      # react-router typegen && tsc --noEmit
npm run test           # vitest run
npm run build          # react-router build + scripts/bundle-server.mjs（server/index.js を生成）
npm run start          # node ./server/index.js（バンドル済みエントリ）
```

- 開発時も Node.js 24 を使う。`bun` は使わない。
- `npm run dev` では Vite がサーバーモジュールを再インポートする。スケジューラは `NODE_ENV !== "production"` では起動しない（[アーキテクチャ設計](architecture.md) 3.3）。
- 開発用の設定例として `dev/config.json` を同梱する。`POWER_MANAGER_CONFIG_PATH=$PWD/dev/config.json` のように絶対パスで指す。起動時に検証を通るため、既定値の適用例と daily / weekly の予約の両方を確認できる。`npm run smoke` も既定でこのファイルを読む（`SMOKE_MANAGED_CONFIG` で差し替え可能）。
- `POWER_MANAGER_PUBLIC_ORIGIN=http://localhost:5173` のように `localhost` の HTTP Origin を開発時のみ許可する。

## 4. Nix パッケージ

### 4.1 flake の出力

- `packages.x86_64-linux.default`
- `packages.aarch64-linux.default`
- `nixosModules.default`
- `devShells.<system>.default`（nodejs_24、openssh、biome）

### 4.2 derivation

`buildNpmPackage` を使い、ネットワークに依存しないビルドを組む（NFR-03）。npm の lock ファイル（`package-lock.json`）をリポジトリに含める。

```nix
{ lib, buildNpmPackage, nodejs_24, makeWrapper, openssh }:

buildNpmPackage {
  pname = "power-manager";
  version = "0.2.0";

  # ビルドに必要なファイルだけを対象にする。docs や .github を変えただけでは
  # derivation のハッシュを動かさない。
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json ./package-lock.json ./tsconfig.json
      ./vite.config.ts ./react-router.config.ts
      ./app ./server ./scripts
    ];
  };

  npmDepsHash = "sha256-...";      # nix build のエラー出力に従って固定する
  nodejs = nodejs_24;

  nativeBuildInputs = [ makeWrapper ];

  buildPhase = ''
    runHook preBuild
    npm run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/power-manager
    cp -r build $out/share/power-manager/build
    install -Dm644 server/index.js $out/share/power-manager/server/index.js
    install -Dm644 package.json $out/share/power-manager/package.json
    npm prune --omit=dev --ignore-scripts
    cp -r node_modules $out/share/power-manager/node_modules

    makeWrapper ${lib.getExe nodejs_24} $out/bin/power-manager \
      --chdir $out/share/power-manager \
      --add-flags "$out/share/power-manager/server/index.js" \
      --prefix PATH : ${lib.makeBinPath [ openssh ]}
    runHook postInstall
  '';

  # 配置したパッケージ単体で起動経路が成立していることを確かめる。
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    share=$out/share/power-manager
    # 配置物の欠落を検出する。
    for artifact in "$share/server/index.js" "$share/build/server/index.js" \
      "$share/build/client" "$share/package.json"; do
      [ -e "$artifact" ] || { echo "配置物が足りません: $artifact" >&2; exit 1; }
    done

    # 環境変数が無ければ待受を開始せず EX_CONFIG（78）で終了すること。
    status=0
    output=$(env -i "$out/bin/power-manager" 2>&1) || status=$?
    [ "$status" -eq 78 ] || { echo "終了コードが 78 ではありません: $status" >&2; exit 1; }
    case "$output" in
      *'"event":"startup_failed"'*) ;;
      *) echo "startup_failed のログが出ていません" >&2; exit 1 ;;
    esac

    # OpenSSH がラッパーの PATH に載っていること。
    grep -q '${lib.makeBinPath [ openssh ]}' "$out/bin/power-manager" || {
      echo "ラッパーの PATH に openssh がありません" >&2; exit 1; }
    runHook postInstallCheck
  '';

  meta = {
    description = "Browser-based personal homelab power manager";
    license = lib.licenses.mit;
    mainProgram = "power-manager";
  };
}
```

- サーバーエントリは `npm run build` の後半で `scripts/bundle-server.mjs`（esbuild）が `server/index.js` にバンドルする。`server/index.ts` をそのまま配置すると、`app/` 配下の TypeScript を相対 import しているため `ERR_MODULE_NOT_FOUND` で起動できない。配置対象はバンドル済みの `server/index.js` だけにする（`server/*.ts` は置かない）。
- `node_modules` は本番依存のみを残す。ビルド後の `installPhase` で `npm prune --omit=dev --ignore-scripts` を実行してから配置する。`npmInstallFlags = [ "--omit=dev" ]` はビルド時の devDependencies（`react-router build`、`esbuild`、`vite`）まで落としてしまうため使わない。
- `doInstallCheck` で、配置物（`server/index.js`、`build/server/index.js`、`build/client`、`package.json`）が揃っていること、環境変数が無い状態で EX_CONFIG（78）と `startup_failed` ログで終了すること、ラッパーの `PATH` に OpenSSH が載っていることを確認する。CI のスモークテストは開発ツリーの `npm run build` を見るため、Nix 配置の抜けはここで捕まえる。
- OpenSSH は `makeWrapper` で `PATH` に追加し、`nix run` と `nix profile install` で `ssh` を発見できるようにする。NixOS モジュールも同様に `PATH` を設定する。
- 実行時にファイルを書かないため、`StateDirectory` は不要（[セキュリティ設計](security.md) 6 章）。

### 4.3 ビルド手順（開発者の確認用）

```sh
npm ci
npm run build
nix build .#default
./result/bin/power-manager   # 環境変数が揃っていなければ exit 78 で終了する（引数は解釈しない）
```

## 5. NixOS モジュール

### 5.1 オプション

| オプション                               | 型       | 既定値                 | 説明                                           |
| ---------------------------------------- | -------- | ---------------------- | ---------------------------------------------- |
| `services.power-manager.enable`          | bool     | `false`                | サービスを有効化する                           |
| `services.power-manager.package`         | package  | flake の既定パッケージ | 実行するパッケージ                             |
| `services.power-manager.environmentFile` | path/str | —                      | 秘密情報を含む systemd `EnvironmentFile`       |
| `services.power-manager.configFile`      | path/str | —                      | 管理対象 JSON（サーバー・グループ・予約）      |

モジュールは秘密値をオプションとして受け取らず、`environmentFile` のパスだけを受け取る（SEC-09）。`configFile` は Nix store のファイルでも `/etc` のファイルでもよいが、**定義を編集して再読込する運用**を取る場合は `/etc` 等の書き換え可能な場所を使う（Nix store は読み取り専用で、変更には再ビルドと再起動が必要）。

`configFile` を指定した場合、モジュールは `Environment=POWER_MANAGER_CONFIG_PATH=<configFile>` を設定する。指定しない場合、`environmentFile` 側の値を使う。

`configFile` を `/home` 配下に指定すると評価時に失敗する（`ProtectHome = true` でサービスから見えないため）。これは `assertions` で検出するので、`nixos-rebuild switch` の前に気付ける。`environmentFile` 内の SSH 秘密鍵・`known_hosts` のパスはモジュールからは参照できないため、5.3 の責務として利用側で守る。

### 5.2 サービス定義

```nix
systemd.services.power-manager = {
  path = [ pkgs.openssh ];   # environment.PATH を直接書かない

  serviceConfig = {
    ExecStart = "${cfg.package}/bin/power-manager";
    EnvironmentFile = cfg.environmentFile;
    Environment = lib.optional (cfg.configFile != null)
      "POWER_MANAGER_CONFIG_PATH=${cfg.configFile}";
    User = "power-manager";
    Group = "power-manager";
    Restart = "on-failure";
    RestartPreventExitStatus = [ 78 ];

    UMask = "0077";

    NoNewPrivileges = true;
    CapabilityBoundingSet = "";
    AmbientCapabilities = "";

    PrivateTmp = true;
    PrivateDevices = true;

    ProtectSystem = "strict";
    ProtectHome = true;
    ProtectControlGroups = true;
    ProtectKernelModules = true;
    ProtectKernelTunables = true;
    ProtectKernelLogs = true;
    ProtectClock = true;
    ProtectHostname = true;

    LockPersonality = true;
    RestrictSUIDSGID = true;
    RestrictRealtime = true;
    RestrictNamespaces = true;
    SystemCallArchitectures = "native";

    RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
  };
};
```

- OpenSSH は `serviceConfig.Environment` ではなく `systemd.services.<name>.path` に置く。NixOS は `path` を既定の `PATH`（coreutils・findutils・gnugrep・gnused・systemd）の後ろへ連結するが、`environment.PATH` を直接定義すると既定値と衝突し、評価が `conflicting definition values` で失敗する。
- `ProtectHome = true` のため、設定 JSON・SSH 秘密鍵・`known_hosts` を `/home` 配下に置かない。`/etc/power-manager` や `/run/secrets` などに置く。
- `AF_UNIX` は DNS リゾルバや journald などのローカルソケット用、`AF_INET` と `AF_INET6` は HTTP 待受、WOL、SSH、TCP 死活確認用である。
- `PrivateNetwork`、`IPAddressDeny`、`SocketBindDeny` は設定しない（loopback 待受と可変宛先への外向き通信が必要なため）。
- `MemoryDenyWriteExecute` と `SystemCallFilter` は Node.js と OpenSSH での動作確認後に追加を検討する。
- Node.js のコンパイルキャッシュ等が書き込みを試みる場合は、`Environment = [ "NODE_COMPILE_CACHE=" "NODE_OPTIONS=--no-warnings" ]` で無効化するか、`PrivateTmp` 配下へ向ける。

### 5.3 ファイルの所有権

サービスは専用の非 root system user `power-manager` として実行する。次を満たすよう配備側で構成する。

- SSH 秘密鍵: `power-manager:power-manager`、`0400` または `0600`
- 管理対象 JSON・`known_hosts`: `power-manager` が読めること
- `environmentFile`: systemd が root で読むため、`power-manager` による直接読取りは不要

モジュールは外部ファイルの所有者・グループ・モードを変更しない。秘密情報の配置は利用側（または `sops-nix` 等）の責務とする。

### 5.4 リバースプロキシ

TLS を終端し、`127.0.0.1:$POWER_MANAGER_PORT` へプロキシする。外部の `Host` とプロトコル情報を転送し、VPN からだけ到達可能にする。`POWER_MANAGER_PUBLIC_ORIGIN` はブラウザが見る Origin と一致させる（SEC-03）。

`/healthz` は loopback からのみ到達可能にし、外部へ公開しない（[セキュリティ設計](security.md) 8 章）。

Nginx の例:

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## 6. CI

GitHub Releases とリリース資産のアップロードは行わない。GitHub Actions は PR と main への push で次を実行する。

- 型検査（`react-router typegen && tsc --noEmit`）
- ユニットテストと HTTP 結合テスト（`vitest run`）
- `x86_64-linux` と `aarch64-linux` の Nix ビルド検証
- `package-lock.json` と `package.json` の不整合検出（`npm ci` が通ること）

フォーマッタとリンタは依存に加えていない。導入する場合は `package.json` のスクリプトと CI の両方を更新する。

## 7. テスト方針

自動テストで少なくとも次を検証する（NFR-11）。ランナーは Vitest、ルートのテストは `createRoutesStub` を使う。

| 対象             | 検証内容                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| 環境変数         | 必須欠落、ポート範囲、Origin の HTTP 許可条件、ハッシュ形式                                                   |
| 設定 JSON        | 未知項目、型不一致、空値、重複 ID（3 集合）、未定義グループ参照、空グループ、MAC、ポート、既定値の適用        |
| 予約定義         | 不正な `target`（両方指定・どちらも未指定）、未定義参照、不正な操作種別、曜日の重複・空、不正な時刻形式        |
| 設定ストア       | 再読込成功時の差し替え、失敗時の旧設定維持（原子性）                                                           |
| スケジューラ     | 次回実行時刻の計算（毎日・毎週、JST、現在時刻より後）、`enabled: false` の除外、`busy` スキップ、10 秒超のスキップ |
| 認証             | 未認証の拒否、`WWW-Authenticate`、誤パスワードの拒否、`/healthz` の免除                                       |
| CSRF             | 不正 `Origin` と `Origin` 欠落の拒否、`allowedActionOrigins` の設定                                            |
| ルーティング     | action の JSON 応答（`fetcher`）と `303` リダイレクト（スクリプト無効時）、結果の種別                          |
| WOL              | Magic Packet のバイト列、宛先・ポート、タイムアウト                                                            |
| SSH 停止         | 引数組立て（鍵・`BatchMode`・`known_hosts`・ポート・ユーザー・コマンド）、タイムアウト、`ssh` 不在時の失敗     |
| 排他制御         | 実行中の同一対象への操作拒否、結果種別の区別、一括時の `busy` スキップと部分失敗の要約                         |
| 死活確認         | 3 状態の判定、同時実行数（固定 8）の上限、進行中確認の共有                                                     |
| 実行結果         | リングバッファの上限 100 件、古い要素の破棄                                                                    |
| 画面             | 出力エスケープ、行内の進行表示、スクリプト無効時のフォーム動作（`createRoutesStub`）                          |

実際の WOL 送信、SSH 接続、VPN・リバースプロキシ経由のアクセスは、ホームラボ上での手動受け入れテストとする。

## 8. 手動受け入れ手順

1. 専用の SSH 鍵を作成し、各対象へ公開鍵を配備する。
2. 各対象の `sudoers` に、停止コマンドのみをパスワードなしで許可する設定を追加する（[セキュリティ設計](security.md) 5 章）。
3. 各対象のホスト鍵を `known_hosts` に登録する。
4. 管理対象 JSON（サーバー・グループ・予約）と環境変数ファイルを作成し、`/home` の外に配置する。
5. NixOS サービスを起動し、`systemctl status power-manager` が active であることを確認する。
6. VPN 経由でリバースプロキシへアクセスし、Basic 認証が求められることを確認する。
7. 一覧表示、グループ見出し、15 秒ごとの状態更新を確認する。タブを非表示にすると更新が止まり、再表示で即座に更新されることを確認する。
8. 単体の起動操作で対象が起動し、URL が変わらず、行内に進行中と結果が表示されることを確認する。
9. 単体の停止操作で確認ページ（`/confirm`）に遷移し、対象の表示名が 1 件出ること、承諾後に対象が停止することを確認する。
10. グループ一括の起動・停止を実行し、対象が全台処理されること、要約（成功・失敗・スキップ）が表示されることを確認する。
11. 一括停止で確認ページが 1 回だけ挟まり、対象の表示名が列挙されることを確認する。
12. 予約を 1〜2 分後に設定し、指定時刻から 10 秒以内に実行されること、実行結果が「最近の実行」に出ることを確認する。
13. 予約時刻に手動操作を重ね、予約が `busy` でスキップされ、理由が表示されることを確認する。
14. サービスを停止して予約時刻をまたぎ、再起動後にその予約が実行されないこと、当日分が二重実行されないことを確認する。
15. 不正な JSON を書き込んで再読込し、旧設定のまま動作継続することと失敗表示を確認する。
16. 不正な環境変数で起動し、終了コード `78` で停止して再起動ループに入らないことを確認する（`systemctl show -p NRestarts`）。
17. 同一サーバーへの二重操作が拒否されることを確認する。
18. ブラウザのスクリプトを無効化し、一覧・起動・停止・再読込がフォーム操作で成立することを確認する。
19. VPN 外から到達できないことを確認する。`/healthz` が外部へ公開されていないことを確認する。

## 9. トラブルシューティング

| 症状                            | 確認点                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| 起動直後に終了する              | `journalctl -u power-manager` で `startup_failed` の理由を確認。環境変数と JSON の検証エラー |
| 状態が常に `unknown`            | `/api/status` が認証付きで取得できているか、ブラウザのコンソールを確認                     |
| 状態が常に `offline`            | 対象の SSH ホスト・ポートへ TCP 到達できるか、名前解決を確認                               |
| 起動操作が効かない              | ブロードキャストアドレスとポート、対象の WOL 設定、同一 LAN かを確認                       |
| 停止が `ssh_unavailable` になる | サービスの `PATH` に `ssh` があるか（`nix run` 以外では明示が必要）                        |
| 停止が失敗する                  | `known_hosts` の登録、鍵の権限、対象側 `sudoers` の許可範囲を確認                          |
| 変更操作が `403` になる         | `POWER_MANAGER_PUBLIC_ORIGIN` とブラウザの Origin、プロキシのヘッダー転送を確認            |
| 操作しても画面が変わらない      | ブラウザのコンソールで action の応答と `fetcher.data` を確認。静的資産の配信パスも確認     |
| 予約が実行されない              | `schedule_run` / `schedule_skip` のログ、`enabled`、時刻（JST）、対象の busy を確認        |
| 予約が実行されすぎる            | 予約 ID の重複、`repeat.days` の内容、再読込の有無を確認                                   |
| 一括操作が一部だけ失敗する      | 対象ごとの `power_operation` ログで `code` を確認（`busy` は仕様どおりのスキップ）         |
