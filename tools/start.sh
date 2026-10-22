#!/usr/bin/env bash
# Standalone browser preview is the default; it does not require a provider key.
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$project_root"
mode="${1:-preview}"
if [ "$mode" = --help ] || [ "$mode" = -h ]; then
  printf 'Usage: bash tools/start.sh [preview|legacy|mcp]\n'
  printf 'preview: local Vite UI; legacy: optional old teaching gateway; mcp: optional adapter.\n'
  exit 0
fi
command -v npm >/dev/null || { printf 'Install Node.js 24 and npm first.\n' >&2; exit 1; }
[ -d node_modules ] || { printf 'Run npm ci in the project root first.\n' >&2; exit 1; }
case "$mode" in
  preview) exec npm run dev --workspace @hpb/mobile ;;
  legacy) exec npm start ;;
  mcp) exec npm run mcp ;;
  *) printf 'Unknown mode: %s. Use --help.\n' "$mode" >&2; exit 2 ;;
esac
