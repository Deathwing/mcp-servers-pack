#!/usr/bin/env bash
set -euo pipefail

# ── MCP Servers — Bundle Script ───────────────────────────────
# Creates a clean, shareable zip of all MCP servers.
# Output: mcp-servers-pack.zip (in the repo root)
#
# Usage:  ./bundleUp.sh
#         ./bundleUp.sh --output /some/other/path.zip

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${1:---output}"
if [[ "$OUTPUT" == "--output" ]]; then
    OUTPUT="$SCRIPT_DIR/mcp-servers-pack.zip"
elif [[ "$1" == "--output" ]]; then
    OUTPUT="${2:?--output requires a path argument}"
fi

# Resolve to absolute path
case "$OUTPUT" in
    /*) ;;                              # already absolute
    *)  OUTPUT="$SCRIPT_DIR/$OUTPUT" ;;
esac

CYAN='\033[0;36m'
GREEN='\033[0;32m'
NC='\033[0m'

info() { echo -e "${CYAN}[bundle]${NC}  $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}     $*"; }

info "Building shareable zip → $OUTPUT"

# Remove existing zip so we start clean
rm -f "$OUTPUT"

# Items to include
INCLUDE=(
    install.sh
    install.bat
    INSTALL.md
    README.md
    image-gen
    orchestrator
    unity-mcp
)

# Exclusion patterns applied to zip
EXCLUDE=(
    "*/.DS_Store"
    "*/__MACOSX/*"
    "*/node_modules/*"
    "*/dist/*"
    "*/.git/*"
    "*/Thumbs.db"
    "*.zip"
)

# Build the -x exclusion flags for zip
EXCLUDE_FLAGS=()
for pattern in "${EXCLUDE[@]}"; do
    EXCLUDE_FLAGS+=(-x "$pattern")
done

cd "$SCRIPT_DIR"

zip -r "$OUTPUT" "${INCLUDE[@]}" "${EXCLUDE_FLAGS[@]}"

SIZE=$(du -sh "$OUTPUT" | cut -f1)
ok "Created $OUTPUT ($SIZE)"
