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
  src = lib.cleanSource ./.;

  # `nix build` が表示するハッシュで固定する。
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-LG9fcT1bZ/uZmfsrxw0aj6PhEGdCcCdFu+tgLaPiFL4=";
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
    cp package.json package-lock.json $out/share/power-manager/

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

  meta = {
    description = "Browser-based personal homelab power manager";
    license = lib.licenses.mit;
    mainProgram = "power-manager";
  };
}
