#!/usr/bin/env bash
# Deno épinglé (même version en local et en CI) pour vérifier et essayer les fonctions Edge, sans
# installation globale : téléchargé par npx, cache dans .tmp/deno.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DENO_DIR="${DENO_DIR:-$ROOT/.tmp/deno}"
export NO_COLOR=1
exec npx -y deno@2.9.6 "$@"
