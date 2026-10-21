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
  npmDepsHash = "sha256-UEQj0bbPsIIWYuzPDIYwkkrQJFaETZE+H+L9CA6420I=";
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
    cp -r server $out/share/power-manager/server
    cp package.json package-lock.json $out/share/power-manager/

    # サーバーエントリは実行時に react-router / zod を解決するため、
    # 本番依存だけを残した node_modules を同梱する。
    npm prune --omit=dev --ignore-scripts
    cp -r node_modules $out/share/power-manager/node_modules

    makeWrapper ${lib.getExe nodejs_24} $out/bin/power-manager \
      --chdir $out/share/power-manager \
      --add-flags "--conditions=react-router $out/share/power-manager/server/index.ts" \
      --prefix PATH : ${lib.makeBinPath [ openssh ]}
    runHook postInstall
  '';

  meta = {
    description = "Browser-based personal homelab power manager";
    license = lib.licenses.mit;
    mainProgram = "power-manager";
  };
}
