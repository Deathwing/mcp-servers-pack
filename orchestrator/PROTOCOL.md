# Agent Orchestration Protocol

A file-locking, messaging, and task-management system for coordinating parallel AI agents working on the same codebase.

## Quick Start

```bash
# Full path to the CLI (set ORCH as a variable for convenience)
ORCH="npx --prefix $HOME/.mcp-servers/orchestrator tsx $HOME/.mcp-servers/orchestrator/src/cli.ts"

# Initialize in a project directory (auto-adds .orch/ to .gitignore)
cd /path/to/project
$ORCH init --project "my-project"
```

## Architecture

```
┌─────────────────┐
│  Orchestrator    │  The main agent — plans, assigns, monitors
│  (main agent)    │
└───────┬─────────┘
        │ spawns via runSubagent
   ┌────┼────┐
   ▼    ▼    ▼
┌────┐┌────┐┌────┐
│ W1 ││ W2 ││ W3 │  Worker agents — execute tasks in parallel
└────┘└────┘└────┘
        │
   .orch/ directory   ← shared state (locks, messages, tasks)
```

**State directory:** `.orch/` in the project root (or wherever `ORCH_DIR` points).

```
.orch/
├── locks/          — One JSON file per active lock
├── messages/       — One JSON file per message
├── tasks/          — One JSON file per task (e.g. 1.json, 2.json)
├── tasks_meta.json — Task board metadata (project name, timestamps)
└── notes.json      — Shared key-value notes
```

## Commands Reference

### Initialization

```bash
$ORCH init                        # Create .orch/ in cwd
$ORCH init --project "port to Go" # Create with project name
$ORCH clean                       # Remove .orch/ entirely
$ORCH status                      # Full overview
```

### File Locking

Prevents two agents from editing the same files simultaneously.

```bash
$ORCH lock <path> <agent>                    # Lock a specific file/directory
$ORCH lock <path> <agent> --recursive        # Lock directory and all children
$ORCH lock <path> <agent> --desc "reason"    # Lock with description
$ORCH unlock <path> <agent>                  # Release a lock (must be owner)
$ORCH unlock-all <agent>                     # Release all locks for an agent
$ORCH locks                                  # List all active locks
$ORCH locked <path>                          # Check if a specific path is locked
```

**Lock rules:**
1. An agent can re-acquire its own lock (idempotent)
2. A recursive lock on `src/` covers all files under `src/`
3. A child lock conflicts with a parent recursive lock by another agent
4. Only the lock owner can release it (or use `unlock-all`)

### Messaging

Fire-and-forget messages between agents. Agents check their inbox when convenient.

```bash
$ORCH send <from> <to> <message>       # Send to a specific agent
$ORCH broadcast <from> <message>       # Send to all agents
$ORCH read <agent>                     # Read + mark as read (returns unread only)
$ORCH messages                         # List all messages
$ORCH messages <agent>                 # List messages for an agent
```

### Task Board

Shared task list for assignment and progress tracking.

```bash
$ORCH task-add <title> <agent>                         # Basic task
$ORCH task-add <title> <agent> --files f1,f2,f3        # With file boundaries
$ORCH task-add <title> <agent> --desc "detailed info"  # With description
$ORCH task-add <title> <agent> --depends-on 1,2        # Depends on tasks #1 and #2
$ORCH task-update <id> <status>                        # Change status
$ORCH task-done <id>                                   # Mark completed
$ORCH task-done <id> "12 files converted"              # Completed with result
$ORCH task-done <id> --files-changed src/a.ts,src/b.ts # Track which files were modified
$ORCH task-fail <id> "Build errors in scene.ts"        # Mark failed with reason
$ORCH tasks                                            # List all tasks (with deps + status)
$ORCH prompt <id>                                      # Generate worker prompt from template
```

**Task statuses:** `pending` → `in-progress` → `completed` | `failed` | `blocked`

**Dependencies:** Tasks with `--depends-on` will show blocked status until all dependency tasks are completed. The `tasks` display shows dependency readiness.

### Shared Notes

Key-value store for cross-agent communication (architecture decisions, conventions, etc.).

```bash
$ORCH note <key> <value>              # Set a note
$ORCH note <key> <value> --agent w1   # Set with author attribution
$ORCH note <key>                      # Read a note
$ORCH note-delete <key>               # Delete a note
$ORCH notes                           # List all notes
```

Notes are included in generated worker prompts (via `prompt` command) so all agents share context.

### Prompt Generation

Auto-generate a worker prompt from the task definition and template:

```bash
$ORCH prompt <task-id>    # Outputs ready-to-use worker prompt to stdout
```

The prompt includes:
- Task assignment (title, files, description)
- Worker instructions from `templates/worker.md`
- Dependency info (if any)
- All shared notes (so the worker has full context)

## Orchestrator Workflow

This is the workflow for the **main agent** (orchestrator):

### 1. Plan & Initialize

```bash
$ORCH init --project "Convert renderer to Rust"
```

Break the work into non-overlapping tasks with clear file boundaries. Tasks should be independent — a worker shouldn't need files assigned to another worker.

### 2. Create Tasks & Lock Files

```bash
# Create tasks with file boundaries
$ORCH task-add "Convert renderer/" worker-1 --files games/tt3d/renderer/ --desc "Port Three.js rendering to wgpu"
$ORCH task-add "Convert physics/" worker-2 --files games/tt3d/physics/ --desc "Port matter.js physics to rapier"
$ORCH task-add "Convert gameplay/" worker-3 --files games/tt3d/gameplay/ --desc "Port gameplay logic to Rust"

# Lock file regions per worker
$ORCH lock games/tt3d/renderer/ worker-1 --recursive
$ORCH lock games/tt3d/physics/ worker-2 --recursive
$ORCH lock games/tt3d/gameplay/ worker-3 --recursive
```

### 3. Spawn Workers

Use `runSubagent` to spawn each worker. Include in the prompt:
- The task assignment (title, files, description)
- Instructions from `templates/worker.md`
- The `ORCH` command prefix so workers can communicate

**Example orchestrator prompt for a worker:**

```
You are worker-1 in a parallel coding project.

YOUR TASK: Convert renderer/ — Port Three.js rendering to wgpu
YOUR FILES: games/tt3d/renderer/ (locked to you)
TASK ID: 1

BEFORE starting work, run:
  ORCH="npx --prefix $HOME/.mcp-servers/orchestrator tsx $HOME/.mcp-servers/orchestrator/src/cli.ts"
  export ORCH_DIR=/path/to/project/.orch
  $ORCH task-update 1 in-progress

ONLY edit files under games/tt3d/renderer/. If you need to read (not write)
files in other directories, that's fine. If you need to modify shared files,
send a message to the orchestrator:
  $ORCH send worker-1 orchestrator "Need to modify shared/types.ts — field X"

When done:
  $ORCH task-done 1 "Converted 12 files, all type-checking"
  $ORCH unlock-all worker-1

Return a summary of what you changed.
```

### 4. Monitor & Integrate

After workers return:

```bash
# Check overall status
$ORCH status

# Read messages from workers
$ORCH read orchestrator

# Verify all tasks completed
$ORCH tasks
```

Handle failures, merge shared-file requests, run integration tests.

### 5. Clean Up

```bash
$ORCH clean
```

## Worker Workflow

This is the workflow for **worker agents** (spawned by the orchestrator):

### 1. Understand Assignment

Read the task description and file boundaries from your prompt.

### 2. Mark In-Progress

```bash
ORCH="npx --prefix $HOME/.mcp-servers/orchestrator tsx $HOME/.mcp-servers/orchestrator/src/cli.ts"
export ORCH_DIR=/path/to/project/.orch

$ORCH task-update <your-task-id> in-progress
```

### 3. Work Within Boundaries

- **ONLY edit files** that are locked to you
- **Reading** any file is always safe
- If you need to modify a file outside your lock, **send a message** instead of editing it

### 4. Communicate

```bash
# Request help or flag a dependency
$ORCH send <your-id> orchestrator "Need shared/types.ts modified: add field X to interface Y"

# Broadcast progress (optional)
$ORCH broadcast <your-id> "50% done — 6/12 files converted"
```

### 5. Complete

```bash
# On success
$ORCH task-done <task-id> "Brief summary of changes"
$ORCH unlock-all <your-id>

# On failure
$ORCH task-fail <task-id> "Reason for failure"
$ORCH unlock-all <your-id>
```

### 6. Return Results

Your final message back to the orchestrator should include:
- What files you created/modified
- Any issues or warnings
- Suggestions for integration work

## Best Practices

### Task Decomposition
- **Non-overlapping files** — each worker gets a distinct set of files
- **Minimal dependencies** — a worker shouldn't block on another worker's output
- **Shared files stay with orchestrator** — files needed by multiple workers should be handled by the orchestrator in a sequential step

### Lock Granularity
- Lock **directories** (with `--recursive`) for broad tasks
- Lock **individual files** for surgical changes
- Release locks immediately after work is done

### Communication
- Workers → orchestrator: report progress, flag blockers, request shared-file changes
- Orchestrator → workers: include everything in the initial prompt (workers can't receive messages mid-task since subagents are one-shot)

### Error Handling
- If a worker fails, the orchestrator should:
  1. Read the failure reason
  2. Release the worker's locks
  3. Either retry with a new worker or handle manually
  4. Update the task board

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ORCH_DIR` | Override .orch/ location | `$PWD/.orch` |

## Troubleshooting

**"No .orch/ found"** — Run `$ORCH init` in the project directory, or set `ORCH_DIR`.

**"Path already locked by ..."** — Another agent owns this file. Check with `$ORCH locks` and coordinate.

**"Lock owned by ..., not ..."** — Only the lock owner can release. Use the correct agent name, or have the orchestrator release via `$ORCH unlock-all <owner>`.

**Stale locks after crash** — Run `$ORCH clean` and reinitialize, or manually `$ORCH unlock-all <agent>`.
