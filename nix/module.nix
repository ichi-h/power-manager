self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.power-manager;
in
{
  options.services.power-manager = {
    enable = lib.mkEnableOption "power-manager";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "self.packages.\${system}.default";
      description = ''
        実行する power-manager パッケージ。既定はこの flake の
        `packages.<system>.default`。
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.either lib.types.path lib.types.str;
      example = "/run/secrets/power-manager/env";
      description = ''
        アプリケーションの実行時設定を並べた systemd `EnvironmentFile` のパス。

        Basic 認証のユーザー名・Argon2id ハッシュ、SSH 秘密鍵のパスなど
        秘密情報を含むため、モジュールは値そのものを受け取らずパスだけを受け取る
        （SEC-09）。systemd が root として読むため、`power-manager` ユーザーが
        読める必要はない。
      '';
    };

    configFile = lib.mkOption {
      type = lib.types.nullOr (lib.types.either lib.types.path lib.types.str);
      default = null;
      example = "/etc/power-manager/config.json";
      description = ''
        管理対象 JSON（サーバー・グループ・予約）のパス。

        指定すると `POWER_MANAGER_CONFIG_PATH` をこの値で設定し、
        `environmentFile` 側の同名の値を上書きする。定義を編集して再読込する運用を
        取る場合は `/etc` など書き換え可能な場所を指定する（Nix store は読み取り
        専用のため、再ビルドと再起動が必要になる）。
      '';
    };
  };

}
