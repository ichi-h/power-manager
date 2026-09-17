{ pkgs ? import <nixpkgs> {} }:
(builtins.getFlake (toString ./.)).packages.${pkgs.system}.default
