# MCP Servers

Three custom MCP servers for VS Code Copilot:

| Server | Purpose | Entry point |
|--------|---------|-------------|
| **orchestrator** | Parallel subagent orchestration (file locking, tasks, messaging) | `src/mcp-server.ts` |
| **image-gen** | Image generation/editing via OpenAI, Gemini, or local SD server | `src/server.ts` |
| **unity-mcp** | Unity Editor bridge (31 tools for scene, assets, build, etc.) | `src/server.ts` |

---

## Quick Install

### macOS / Linux

```bash
chmod +x install.sh
./install.sh                              # install all 3 servers
```

### Windows

```cmd
install.bat                               # install all 3 servers
```

Both scripts install all servers to `~/.mcp-servers/` and run `npm install`.
For `unity-mcp`, the installed package now includes the nested `unity-plugin/` folder so the server can wire Unity projects itself through `unity_get_status` and `unity_install_package`.

---

## Manual Install

If you prefer manual setup:

```bash
# 1. Create target directory
mkdir -p ~/.mcp-servers

# 2. Copy each server
cp -r orchestrator ~/.mcp-servers/orchestrator
cp -r image-gen    ~/.mcp-servers/image-gen
cp -r unity-mcp    ~/.mcp-servers/unity-mcp

# 3. Install dependencies
cd ~/.mcp-servers/orchestrator && npm install
cd ~/.mcp-servers/image-gen    && npm install
cd ~/.mcp-servers/unity-mcp    && npm install

# 4. (Unity only) After configuring the server in VS Code, use:
#    unity_get_status with projectPath to inspect the Unity project
#    unity_install_package with projectPath to add the local package ref
```

---

## VS Code Configuration

Add to your `.vscode/mcp.json` (or VS Code user settings):

```jsonc
{
  "servers": {
    // ── Orchestrator ──
    "orchestrator": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--prefix", "~/.mcp-servers/orchestrator",
        "tsx", "~/.mcp-servers/orchestrator/src/mcp-server.ts"
      ]
    },

    // ── Image Generation ──
    "image-gen": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--prefix", "~/.mcp-servers/image-gen",
        "tsx", "~/.mcp-servers/image-gen/src/server.ts"
      ],
      "env": {
        "OPENAI_API_KEY": "${input:openaiKey}",
        "GEMINI_API_KEY": "${input:geminiKey}",
        "LOCAL_SD_URL": "${input:localSdUrl}"
      }
    },

    // ── Unity MCP ──
    "unity-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--prefix", "~/.mcp-servers/unity-mcp",
        "tsx", "~/.mcp-servers/unity-mcp/src/server.ts"
      ]
    }
  },
  "inputs": [
    {
      "type": "promptString",
      "id": "openaiKey",
      "description": "OpenAI API Key for image generation",
      "password": true
    },
    {
      "type": "promptString",
      "id": "geminiKey",
      "description": "Google Gemini API Key for image generation (optional)",
      "password": true
    },
    {
      "type": "promptString",
      "id": "localSdUrl",
      "description": "Local SD server URL (e.g. http://127.0.0.1:1234) — leave empty to skip"
    }
  ]
}
```

> **Windows**: Replace `~/.mcp-servers` with the full path, e.g. `C:/Users/admin/.mcp-servers`. Use forward slashes in JSON.

> **Tip**: Instead of the `inputs` prompt, you can set `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `LOCAL_SD_URL` in your shell profile (`.bashrc`, `.zshrc`, or System Environment Variables on Windows). At least one provider key or local URL is required; multiple can be set to choose per tool call.

---

## Server Details

### Orchestrator

Parallel agent orchestration with file locking, task tracking, and inter-agent messaging.

**MCP Tools:**
- `orchestrate_goal` — Give a high-level goal, Orchestrator agent plans and spawns workers
- `orchestrate_work` — Pre-planned: specify exact tasks, workers execute them
- `spawn_workers` — Low-level: spawn N CLI workers
- `orch_status` — Read current `.orch/` status

**CLI** (also usable directly):
```bash
# Define shortcut
orch() { npx --prefix ~/.mcp-servers/orchestrator tsx ~/.mcp-servers/orchestrator/src/cli.ts "$@"; }

orch init --project "feature-name"
orch task-add "Build renderer" worker-1 --files "src/renderer/"
orch status
```

**Files:**
- `src/mcp-server.ts` — MCP server (stdio transport)
- `src/cli.ts` — CLI tool
- `src/lock.ts`, `task.ts`, `message.ts`, `note.ts`, `utils.ts` — Core modules
- `agents/` — VS Code agent definitions (Orchestrator.agent.md, Worker.agent.md)
- `templates/worker.md` — Worker prompt template
- `PROTOCOL.md` — Full protocol documentation

### Image Gen

Image generation, editing, analysis, and processing. Triple provider: OpenAI (gpt-image-1, GPT-4o), Google Gemini (Imagen, Flash), and **local** (any OpenAI-compatible or A1111/Forge server — run FLUX, SDXL, SD3.5 on your own hardware).

**MCP Tools (12):**
- `generate_image` — Generate images from text prompts (OpenAI, Gemini, or local)
- `edit_image` — Edit existing images with text prompts (OpenAI, Gemini, or local)
- `image_to_base64` — Convert images to base64 data URIs (with optional resize)
- `get_image_info` — Get image metadata (dimensions, format, size, channels)
- `describe_image` — Analyze/describe image content via vision AI
- `compare_images` — Visual diff between two images via vision AI
- `resize_image` — Resize images with multiple fit modes
- `crop_image` — Extract a rectangular region from an image
- `remove_background` — Remove image background via AI inpainting (OpenAI, Gemini, or local)
- `composite_images` — Layer multiple images with blend modes and opacity
- `convert_image` — Convert between formats (PNG, JPEG, WebP, AVIF, TIFF)
- `create_sprite_sheet` — Pack images into a grid sprite sheet with JSON atlas
- `create_tileable` — Make a texture seamlessly tileable via AI seam repair (OpenAI, Gemini, or local)

**Requires:** At least one of `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `LOCAL_SD_URL`. Multiple can be set to choose per tool call.

**Local Provider Setup (optional):**
1. Install [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) — the llama.cpp of image generation
2. Download a model (e.g. FLUX, SDXL, SD3.5) in GGUF or safetensors format
3. Start the server: `sd-server -m model.safetensors --listen-port 1234`
4. Set `LOCAL_SD_URL=http://127.0.0.1:1234`
5. Use `provider: "local"` in tool calls

Also works with AUTOMATIC1111/Forge (`--api` flag, port 7860) and any OpenAI-compatible image API.

**Files:**
- `src/server.ts` — MCP server entry point (v4.0.0)
- `src/tools/*.ts` — Individual tool implementations (12 files)

### Unity MCP

Bridge between VS Code Copilot and Unity Editor. The Node.js MCP server proxies tool calls over TCP to a C# plugin running inside Unity.

**Architecture:** `VS Code ──stdio──> Node.js MCP Server ──TCP:52719──> Unity Editor (C# TCP Listener)`

**31 Tools** across 13 categories:
Scene, GameObject, Transform, Asset, Prefab, Script, Build, Editor, Animation, Physics, Profiler, View, Package

**MCP Resources:**
- `unity://project/info` — Project name, version, platform
- `unity://scene/hierarchy` — Current scene tree
- `unity://console/logs` — Recent console output
- `unity://editor/state` — Play mode, compilation, platform

**Files:**
- `src/` — Node.js MCP proxy server and local bootstrap tools
- `unity-plugin/` — Unity package root containing the Editor plugin and package manifest

The root install flow and the `unity_get_status` / `unity_install_package` tools are the canonical Unity setup path.

---

## Prerequisites

- **Node.js 18+** and **npm**
- **Unity 2021.3+** (for unity-mcp plugin)
- **OpenAI API key** and/or **Google Gemini API key** and/or **local SD server** (for image-gen; at least one required)

---

## Troubleshooting

**npm install fails on `sharp` (image-gen)**
`sharp` has native bindings. On Windows, you may need the Visual C++ Build Tools. On macOS, ensure Xcode Command Line Tools are installed (`xcode-select --install`).

**Unity MCP doesn't connect**
1. Check Unity Console for `[UnityMCP] Listening on 127.0.0.1:52719`
2. If the port is in use: `lsof -i :52719` (macOS) or `netstat -an | findstr 52719` (Windows)
3. Restart Unity Editor

**Orchestrator `copilot` CLI not found**
The orchestrator spawns workers via the `copilot` CLI. Install it: `npm install -g @anthropic-ai/copilot` or ensure `copilot` is on your PATH.
