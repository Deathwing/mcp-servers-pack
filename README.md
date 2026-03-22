# MCP Servers Pack

A collection of MCP servers for VS Code Copilot — covering parallel agent orchestration, AI image generation, and Unity Editor integration.

Included components:

- `orchestrator` — parallel worker orchestration and task coordination
- `image-gen` — image generation, editing, analysis, and processing
- `unity-mcp` — Unity Editor bridge with a TypeScript MCP server and a Unity package plugin

## Requirements

- **Node.js 18+** and **npm**
- **VS Code** with [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension
- For `image-gen`: an OpenAI and/or Google Gemini API key (or a local Stable Diffusion server)
- For `unity-mcp`: Unity Editor (2021.3+)

## Install

See [INSTALL.md](INSTALL.md) for the full install guide.

```bash
# macOS / Linux
chmod +x install.sh && ./install.sh

# Windows
install.bat
```

## Servers

### `orchestrator`

Spawns parallel Copilot CLI workers and coordinates them via file-based task board, locking, messaging, and shared notes.

| Tool | Description |
|---|---|
| `orchestrate_goal` | Give a high-level goal — the Orchestrator agent decomposes it into tasks, spawns workers, and manages the full lifecycle |
| `orchestrate_work` | Provide an explicit pre-planned task list and run them in parallel (with wave ordering and concurrency controls) |
| `spawn_workers` | Low-level: spawn N Copilot CLI workers for a specific prompt |
| `cancel_orchestration` | Kill all workers for a given orchestration run |
| `orch_status` | Read current task board, locks, notes, and messages from the `.orch/` state directory |

See [orchestrator/PROTOCOL.md](orchestrator/PROTOCOL.md) for the full CLI reference.

---

### `image-gen`

AI image generation and processing. Supports OpenAI (`gpt-image-1`), Google Gemini, and local Stable Diffusion (A1111 / ComfyUI).

| Tool | Description |
|---|---|
| `generate_image` | Generate an image from a text prompt |
| `edit_image` | Edit an existing image with a prompt (inpainting / outpainting) |
| `describe_image` | Describe the contents of an image using vision AI |
| `compare_images` | Compare two images and return a diff description |
| `resize_image` | Resize an image to specific dimensions |
| `crop_image` | Crop an image to a region |
| `convert_image` | Convert between image formats (PNG, JPEG, WebP, AVIF, …) |
| `composite_images` | Layer multiple images together |
| `create_sprite_sheet` | Pack images into a sprite sheet atlas |
| `create_tileable` | Make an image seamlessly tileable via AI seam repair |
| `remove_background` | Remove the background from an image |
| `get_image_info` | Return dimensions, format, and metadata for an image |
| `image_to_base64` | Encode an image file as a base64 data URL |
| `setup_stable_diffusion` | Configure and test connection to a local SD server |

**Required env vars** (set at least one provider):
```
OPENAI_API_KEY      — OpenAI
GEMINI_API_KEY      — Google Gemini
SD_API_URL          — Local Stable Diffusion (e.g. http://127.0.0.1:7860)
```

---

### `unity-mcp`

Unity Editor bridge. A TypeScript MCP server talks to a C# TCP server inside the Unity Editor, exposing Unity internals as MCP tools discovered via reflection.

**Bootstrap tools** (always available):

| Tool | Description |
|---|---|
| `unity_get_status` | Check bridge connectivity, compile errors, and project setup |
| `unity_open_project` | Launch Unity Editor with a specific project path |
| `unity_install_package` | Add the unity-mcp C# plugin to a Unity project's `manifest.json` and configure `.vscode/mcp.json` |

**Dynamic tools** (available once Unity is connected):

| Tool | Description |
|---|---|
| `manage_scene` | Load, save, create, and inspect scenes |
| `manage_gameobject` | Create, find, modify, and delete GameObjects and components |
| `manage_transform` | Get/set position, rotation, and scale; coordinate space conversions |
| `manage_asset` | Import, move, copy, delete, and inspect project assets |
| `manage_script` | Create, read, update, and delete C# scripts |
| `manage_animation` | Inspect and modify Animators and AnimationClips |
| `manage_prefab` | Instantiate, apply, revert, and unpack prefabs |
| `manage_build` | Configure build settings, switch platform, trigger builds |
| `manage_packages` | List, add, and remove UPM packages |
| `manage_physics` | Raycast, overlap queries, rigidbody inspection |
| `manage_profiler` | Memory, GC, and frame timing profiler data |
| `manage_editor` | Play/pause/stop, console read, evaluate C# expressions |
| `find_project_assets` | Search assets by type, name, or label |
| `find_in_file` | Text search within script files |
| `apply_text_edits` | Apply precise text edits to script files |
| `read_console` | Read Unity console messages (log/warning/error) |
| `execute_menu_item` | Invoke any Unity menu item by path |
| `evaluate_expression` | Evaluate a C# expression in the Editor context |
| `camera_capture` | Capture a screenshot from a scene camera |
| `get_selection` / `set_selection` | Get or set the current Editor selection |
| `run_tests` | Run Unity Test Runner tests and return results |

See [INSTALL.md](INSTALL.md) for setup instructions.

---

## Layout

- [orchestrator](orchestrator/)
- [image-gen](image-gen/)
- [unity-mcp](unity-mcp/)

## Unity MCP Notes

`unity-mcp` contains two parts:

- [unity-mcp](unity-mcp/) — the installed server package root under `~/.mcp-servers/unity-mcp`
- [unity-mcp/unity-plugin](unity-mcp/unity-plugin/) — the local Unity package used by `unity_install_package`

Unity-specific install and configuration details are documented in [INSTALL.md](INSTALL.md).