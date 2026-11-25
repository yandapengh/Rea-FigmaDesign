#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_ROOT="${DSH_HOME:-}"
[ -z "$DSH_ROOT" ] && DSH_ROOT="$HOME/.dsh"
TARGET="$DSH_ROOT/skills"
mkdir -p "$TARGET"
rm -rf "$TARGET/rea-figma-design"
cp -R "$ROOT/.dsh/skills/rea-figma-design" "$TARGET/rea-figma-design"
printf '%s\n' "$ROOT" > "$TARGET/rea-figma-design/.repo-root"
echo "installed rea-figma-design -> $TARGET/rea-figma-design (repo: $ROOT)"
