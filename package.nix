{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
  openssh,
}:

buildNpmPackage {
  pname = "power-manager";
  version = "0.2.0";

  # ビルドに必要なファイルだけを対象にする。`cleanSource ./.` では docs や `.github` を
  # 変更しただけでも derivation のハッシュが変わり、無関係な再ビルドが起きる。
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./tsconfig.json
      ./vite.config.ts
      ./react-router.config.ts
      ./app
      ./server
      ./scripts
    ];
  };

  # `npm run build` の出力（ビルド成果物・バンドル済みエントリ）をそのまま配置する。
  # npm の lock ファイルから依存を取得するため、ビルド中にネットワークを使わない（NFR-03）。
  # ハッシュは `nix build` のエラー出力に従って固定する。
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-APbb+GAxqJszZVh5APx7aES7bBuBllUBsqM+U0hTI9U=";
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

    # `npm run build` が生成したバンドル済みエントリだけを配置する。`server/index.ts` は
    # `app/` 配下の TypeScript を相対 import するため、ソースツリーを置かない配置では
    # 起動できない（ERR_MODULE_NOT_FOUND）。
    install -Dm644 server/index.js $out/share/power-manager/server/index.js

    # 実行時のモジュール解決に使う `package.json`（`"type": "module"`）だけを置く。
    install -Dm644 package.json $out/share/power-manager/package.json

    # バンドルは依存パッケージを external のまま残すため、本番依存だけを
    # 同梱した node_modules を置く。
    npm prune --omit=dev --ignore-scripts
    cp -r node_modules $out/share/power-manager/node_modules

    makeWrapper ${lib.getExe nodejs_24} $out/bin/power-manager \
      --chdir $out/share/power-manager \
      --add-flags "$out/share/power-manager/server/index.js" \
      --prefix PATH : ${lib.makeBinPath [ openssh ]}
    runHook postInstall
  '';

  # 配置したパッケージ単体で起動経路が成立していることを確かめる。CI のスモークテストは
  # 開発ツリーの `npm run build` を見るため、Nix 配置の抜け（バンドルや `package.json`
  # の置き忘れ）はここで捕まえる。
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck

    share=$out/share/power-manager
    for artifact in \
      "$share/server/index.js" \
      "$share/build/server/index.js" \
      "$share/build/client" \
      "$share/package.json"; do
      if [ ! -e "$artifact" ]; then
        echo "配置物が足りません: $artifact" >&2
        exit 1
      fi
    done

    # 秘密値も含め環境変数が無い状態では、待受を開始せず EX_CONFIG（78）で終了すること。
    # ラッパーが node を絶対パスで起動するため、PATH は空でも動く。
    status=0
    output=$(env -i "$out/bin/power-manager" 2>&1) || status=$?
    if [ "$status" -ne 78 ]; then
      echo "設定不備時の終了コードが 78 ではありません: $status" >&2
      echo "$output" >&2
      exit 1
    fi
    case "$output" in
      *'"event":"startup_failed"'*) ;;
      *)
        echo "startup_failed のログが出ていません:" >&2
        echo "$output" >&2
        exit 1
        ;;
    esac

    # OpenSSH は実行時依存としてラッパーの PATH に載っていること（NFR-03）。
    if ! grep -q '${lib.makeBinPath [ openssh ]}' "$out/bin/power-manager"; then
      echo "ラッパーの PATH に openssh が含まれていません" >&2
      exit 1
    fi

    runHook postInstallCheck
  '';

  meta = {
    description = "Browser-based personal homelab power manager";
    license = lib.licenses.mit;
    mainProgram = "power-manager";
  };
}
