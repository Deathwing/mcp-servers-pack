# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [4.1.0] — 2026-04-23

### Added (image-gen)
- `count` parameter on `generate_image` (1–10): generate multiple image variations in one call. OpenAI uses a single API request with `n`; Gemini and local SD make sequential calls. When `save_to` is set and `count > 1`, files are written as `name_1.ext`, `name_2.ext`, etc.

### Changed (image-gen)
- Upgraded default OpenAI model from `gpt-image-1` / `gpt-image-1.5` to `gpt-image-2` across all tools (`generate_image`, `edit_image`, `create_tileable`, `remove_background`)
- Updated Gemini model descriptions from stale `imagen-4.0-generate-001` / `imagen-3.0-capability-001` to current `gemini-3-pro-image-preview`
- Added caveat to `background: "transparent"` docs — `gpt-image-2` does not support transparent backgrounds; use `model="gpt-image-1"` instead

---

## [1.0.0] — 2026-03-19

### Added
- **orchestrator** — parallel agent orchestration with file locking, task board, messaging, and shared notes. Tools: `orchestrate_goal`, `orchestrate_work`, `spawn_workers`, `cancel_orchestration`, `orch_status`
- **image-gen** — AI image generation and processing via OpenAI, Gemini, or local Stable Diffusion. Tools: `generate_image`, `edit_image`, `describe_image`, `compare_images`, `resize_image`, `crop_image`, `convert_image`, `composite_images`, `create_sprite_sheet`, `create_tileable`, `remove_background`, `get_image_info`, `image_to_base64`, `setup_stable_diffusion`
- **unity-mcp** — Unity Editor bridge with 22 tools exposed via C# reflection over a TCP socket. Local tools: `unity_get_status`, `unity_install_package`, `unity_open_project`
- `install.sh` / `install.bat` — cross-platform installer to `~/.mcp-servers/`
- `bundleUp.sh` — creates a clean shareable zip (no `node_modules`/`dist`)
