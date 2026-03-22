#!/usr/bin/env bash
set -euo pipefail

# ── MCP Servers — Installer (macOS / Linux) ──────────────────
# Installs: orchestrator, image-gen, unity-mcp
# Target:   ~/.mcp-servers/<name>/

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $*" >&2; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*" >&2; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*" >&2; }
error() { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_HOME="$HOME/.mcp-servers"

paths_resolve_equal() {
    local left="$1"
    local right="$2"

    [[ -e "$left" ]] || return 1
    [[ -e "$right" ]] || return 1

    local left_resolved right_resolved
    left_resolved="$(cd "$left" 2>/dev/null && pwd -P)" || return 1
    right_resolved="$(cd "$right" 2>/dev/null && pwd -P)" || return 1

    [[ "$left_resolved" == "$right_resolved" ]]
}

check_prereqs() {
    info "Checking prerequisites..."

    command -v node >/dev/null 2>&1 || error "Node.js is not installed. Install from https://nodejs.org"
    local node_ver
    node_ver=$(node -v | sed 's/v//')
    local node_major
    node_major=$(echo "$node_ver" | cut -d. -f1)
    [[ "$node_major" -ge 18 ]] || error "Node.js 18+ required (found $node_ver)"
    ok "Node.js v$node_ver"

    command -v npm >/dev/null 2>&1 || error "npm is not installed"
    ok "npm $(npm -v)"
}

install_mcp() {
    local name="$1"
    local source_dir="$SCRIPT_DIR/$name"
    local target_dir="$MCP_HOME/$name"

    if [[ ! -d "$source_dir" ]]; then
        warn "Source directory not found: $source_dir — skipping $name"
        return 1
    fi

    info "Installing $name to $target_dir ..."

    if paths_resolve_equal "$source_dir" "$target_dir"; then
        info "$name target already resolves to source; skipping file sync"
    else
        mkdir -p "$target_dir"
        rsync -a --delete --exclude='node_modules' "$source_dir/" "$target_dir/"
    fi

    info "Installing npm dependencies for $name ..."
    (cd "$target_dir" && npm install --silent 2>&1) >&2

    ok "$name installed"
    echo "$target_dir"
}

main() {
    echo "" >&2
    echo -e "${CYAN}═══════════════════════════════════════════════════${NC}" >&2
    echo -e "${CYAN}     MCP Servers — Installer (macOS/Linux) ${NC}" >&2
    echo -e "${CYAN}═══════════════════════════════════════════════════${NC}" >&2
    echo "" >&2

    if [[ $# -gt 0 ]]; then
        case "$1" in
            --help|-h)
                echo "Usage: ./install.sh" >&2
                echo "" >&2
                echo "Installs all MCP servers to ~/.mcp-servers/." >&2
                echo "Unity project wiring now happens through the unity_get_status and unity_install_package MCP tools." >&2
                exit 0
                ;;
            *)
                error "Unexpected argument: $1. Unity project installation moved into the unity_install_package MCP tool."
                ;;
        esac
    fi

    check_prereqs

    echo "" >&2
    info "── Installing MCP servers to $MCP_HOME ──"
    echo "" >&2

    local orchestrator_dir image_gen_dir unity_mcp_dir

    orchestrator_dir=$(install_mcp "orchestrator")
    image_gen_dir=$(install_mcp "image-gen")
    unity_mcp_dir=$(install_mcp "unity-mcp")

    echo "" >&2
    echo -e "${GREEN}═══════════════════════════════════════════════════${NC}" >&2
    echo -e "${GREEN}  Installation complete!${NC}" >&2
    echo -e "${GREEN}═══════════════════════════════════════════════════${NC}" >&2
    echo "" >&2
    echo "  Installed:" >&2
    echo "    Orchestrator: $orchestrator_dir" >&2
    echo "    Image Gen:    $image_gen_dir" >&2
    echo "    Unity MCP:    $unity_mcp_dir" >&2
    echo "" >&2
    echo "  Next steps:" >&2
    echo "    1. Add MCP servers to your VS Code mcp.json (see INSTALL.md)" >&2
    echo "    2. For image-gen: set OPENAI_API_KEY and/or GEMINI_API_KEY, or LOCAL_SD_URL for local generation" >&2
    echo "    3. For Unity projects: call unity_get_status and unity_install_package from the unity-mcp server" >&2
    echo "" >&2
}

main "$@"
