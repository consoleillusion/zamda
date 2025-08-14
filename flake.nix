{
  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, flake-utils, nixpkgs }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        name = "Zamda";
        prompt = "λ";
        color = "4";
        pkgs = (import nixpkgs) {inherit system;};
      in {

        devShell = pkgs.mkShell {
          shellHook = ''
            export ENVIRONMENT_NAME="${name}"
            export PS1="\[\e[1;38;5;${color}m\]${prompt}\[\e[0m\] "

            set -a
            source .env
            set +a
    
            clear
            echo -e "Welcome to \e[38;5;${color}m$ENVIRONMENT_NAME\e[0m"

          '';
          nativeBuildInputs =
            [ pkgs.bun
             pkgs.zig_0_13
            ];
        };
      }
    );
}
