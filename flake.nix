{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = [
              pkgs.python313
              pkgs.uv
              pkgs.ruff
              pkgs.ty
              pkgs.gnumake
              pkgs.ffmpeg
              pkgs.deno
            ];

            shellHook = ''
              export UV_PYTHON_DOWNLOADS=never
              export UV_PYTHON=${pkgs.python313}/bin/python3.13
            '';
          };
        });
    };
}
