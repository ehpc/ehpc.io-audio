{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.python313
          pkgs.uv
          pkgs.ruff
          pkgs.ty
          pkgs.gnumake
        ];

        shellHook = ''
          export UV_PYTHON_DOWNLOADS=never
          export UV_PYTHON=${pkgs.python313}/bin/python3.13
        '';
      };
    };
}
