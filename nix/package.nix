# Adapted from snlr308/scrim-nix. See ../LICENSES/scrim-nix-MIT.txt.
{
  lib,
  stdenv,
  rustPlatform,
  fetchurl,
  python3,
  src,
}:

let
  manifest = lib.importTOML ../scrim/Cargo.toml;
  v8Pin = manifest.dependencies.v8;
  v8Version = lib.removePrefix "=" v8Pin;
  # Keep the prebuilt archive and its hash in sync with the exact Cargo pin.
  v8Hashes = {
    "150.4.0" = "sha256-WGn9twcbHyHyAKl86X0gElh34PMc2ALtmd4sU/SIsGw=";
  };
  target = stdenv.hostPlatform.rust.rustcTarget;
  v8Archive = fetchurl {
    url = "https://github.com/denoland/rusty_v8/releases/download/v${v8Version}/librusty_v8_release_${target}.a.gz";
    hash = v8Hashes.${v8Version} or (throw "scrim: add the x86_64-linux V8 archive hash for ${v8Version}");
  };
in
assert lib.hasPrefix "=" v8Pin && manifest.build-dependencies.v8 == v8Pin;
rustPlatform.buildRustPackage {
  pname = "scrim";
  inherit (manifest.package) version;
  inherit src;
  sourceRoot = "source/scrim";

  # Cargo.lock has both a registry and a Git copy of debug_timer 0.1.3.
  cargoHash = "sha256-N26W9wQgfypGQhKbA88ARl/UJqSnnxq+Id+BJoWNwLY=";
  # The v8 build script reads this local archive inside the sandbox.
  env.RUSTY_V8_ARCHIVE = v8Archive;

  doInstallCheck = true;
  nativeInstallCheckInputs = [ python3 ];
  installCheckPhase = ''
    runHook preInstallCheck
    python3 ${./smoke.py} "$out/bin/scrim"
    runHook postInstallCheck
  '';

  meta = {
    description = "Minimal headless browser for AI agents";
    homepage = "https://github.com/strelov1/scrim";
    license = lib.licenses.mit;
    mainProgram = "scrim";
    platforms = [ "x86_64-linux" ];
    sourceProvenance = with lib.sourceTypes; [
      fromSource
      binaryNativeCode
    ];
  };
}
