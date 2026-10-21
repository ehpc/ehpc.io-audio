{
  # Last maintained nixpkgs branch for Intel Macs; also provides stable Python 3.15.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

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
              pkgs.python315
              pkgs.uv
              pkgs.gnumake
              pkgs.ffmpeg
              pkgs.rubberband
              pkgs.keyfinder-cli
              pkgs.deno
              pkgs.nodejs
              # ruff and ty come from the dev dependency group (uv run ruff / ty)
              # so CI and local use identical versions.
            ];

            shellHook = ''
              export UV_PYTHON_DOWNLOADS=never
              export UV_PYTHON=${pkgs.python315}/bin/python3.15
              # Keep the venv out of the (Dropbox-synced) project tree. A venv is
              # platform-specific — absolute shebangs, native binaries — so
              # syncing it between machines corrupts it.
              export UV_PROJECT_ENVIRONMENT="$HOME/.cache/vocals-tools/venv"
            '';
          };
        });
    };
}
