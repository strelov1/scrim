{
  description = "scrim, a minimal headless browser for AI agents";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      scrim = pkgs.callPackage ./nix/package.nix { src = self.outPath; };
    in
    {
      packages.${system} = {
        inherit scrim;
        default = scrim;
      };
    };
}
