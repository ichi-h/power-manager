{
  description = "Browser-based personal homelab power manager";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.callPackage ./package.nix { };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              openssh
              biome
            ];
          };
        }
      );

      nixosModules.default = import ./nix/module.nix self;

      # `nix flake check` はモジュールの option 定義しか評価しないため、NixOS 構成に
      # 組み込んだときの衝突（例: `environment.PATH` の二重定義）を検出できない。
      # 実際に構成を評価して unit の中身を突き合わせる。
      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          lib = nixpkgs.lib;
          mkSystem =
            extra:
            lib.nixosSystem {
              inherit system;
              modules = [
                self.nixosModules.default
                {
                  system.stateVersion = "24.11";
                  # パッケージのビルドは不要。unit の ExecStart はパス文字列として
                  # 評価されるだけで、チェックの derivation には取り込まれない。
                  boot.loader.grub.enable = false;
                  fileSystems."/" = {
                    device = "/dev/null";
                    fsType = "ext4";
                  };
                }
                extra
              ];
            };
          unitOf = extra: (mkSystem extra).config.systemd.units."power-manager.service".text;
          enabled = unitOf {
            services.power-manager = {
              enable = true;
              environmentFile = "/run/secrets/power-manager/env";
              configFile = "/etc/power-manager/config.json";
            };
          };
          enabledWithoutConfigFile = unitOf {
            services.power-manager = {
              enable = true;
              environmentFile = "/run/secrets/power-manager/env";
            };
          };
          # enable = false のとき unit が生成されないことを真偽値で受け取る。
          disabledHasUnit = (mkSystem { }).config.systemd.units ? "power-manager.service";
          # `/home` 配下の `configFile` は `ProtectHome = true` で読めないため、
          # 評価時点で止める。`config.assertions` を直接見れば toplevel を評価せずに確かめられる。
          homeConfigFileRejected =
            lib.any (a: a.assertion == false)
              (mkSystem {
                services.power-manager = {
                  enable = true;
                  environmentFile = "/run/secrets/power-manager/env";
                  configFile = "/home/power-manager/config.json";
                };
              }).config.assertions;
          validConfigAccepted =
            !(lib.any (a: a.assertion == false) (
              (mkSystem {
                services.power-manager = {
                  enable = true;
                  environmentFile = "/run/secrets/power-manager/env";
                  configFile = "/etc/power-manager/config.json";
                };
              }).config.assertions
            ));

          expectedLines = [
            "Environment=POWER_MANAGER_CONFIG_PATH=/etc/power-manager/config.json"
            "EnvironmentFile=/run/secrets/power-manager/env"
            "AmbientCapabilities="
            "CapabilityBoundingSet="
            "Group=power-manager"
            "LockPersonality=true"
            "NoNewPrivileges=true"
            "PrivateDevices=true"
            "PrivateTmp=true"
            "ProtectClock=true"
            "ProtectControlGroups=true"
            "ProtectHome=true"
            "ProtectHostname=true"
            "ProtectKernelLogs=true"
            "ProtectKernelModules=true"
            "ProtectKernelTunables=true"
            "ProtectSystem=strict"
            "Restart=on-failure"
            "RestartPreventExitStatus=78"
            "RestrictAddressFamilies=AF_UNIX"
            "RestrictAddressFamilies=AF_INET"
            "RestrictAddressFamilies=AF_INET6"
            "RestrictNamespaces=true"
            "RestrictRealtime=true"
            "RestrictSUIDSGID=true"
            "SystemCallArchitectures=native"
            "UMask=0077"
            "User=power-manager"
            "WantedBy=multi-user.target"
          ];
        in
        {
          nixos-module = pkgs.runCommand "check-nixos-module" { } ''
            set -eu

            unit=${lib.escapeShellArg enabled}
            unitWithoutConfigFile=${lib.escapeShellArg enabledWithoutConfigFile}

            for line in ${lib.escapeShellArgs expectedLines}; do
              printf '%s\n' "$unit" | grep -qxF "$line" || {
                echo "power-manager.service に期待する行がありません: $line" >&2
                exit 1
              }
            done

            # OpenSSH は systemd の PATH に載っていること（NFR-03）。NixOS はこの行を
            # 生成するので、`path` ではなく `environment.PATH` に戻すと評価自体が失敗する。
            printf '%s\n' "$unit" | grep -q '^Environment="PATH=.*openssh' || {
              echo "PATH に OpenSSH が含まれていません" >&2
              exit 1
            }

            # configFile 未指定なら、environmentFile 側の値を使って上書きしないこと。
            if printf '%s\n' "$unitWithoutConfigFile" | grep -q 'POWER_MANAGER_CONFIG_PATH'; then
              echo "configFile 未指定なのに POWER_MANAGER_CONFIG_PATH を設定しています" >&2
              exit 1
            fi
            printf '%s\n' "$unitWithoutConfigFile" | grep -qxF \
              'EnvironmentFile=/run/secrets/power-manager/env' || {
              echo "EnvironmentFile が設定されていません" >&2
              exit 1
            }

            # 無効時は unit を作らない。
            if [ ${if disabledHasUnit then "1" else "0"} = 1 ]; then
              echo "enable = false でも unit が生成されています" >&2
              exit 1
            fi

            # /home 配下の configFile は評価時に拒否し、/etc 配下は通すこと。
            if [ ${if homeConfigFileRejected then "1" else "0"} != 1 ]; then
              echo "/home 配下の configFile を拒否していません" >&2
              exit 1
            fi
            if [ ${if validConfigAccepted then "1" else "0"} != 1 ]; then
              echo "/etc 配下の configFile を許容していません" >&2
              exit 1
            fi

            touch $out
          '';
        }
      );
    };
}
