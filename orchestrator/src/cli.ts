#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, appendFileSync, readdirSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrchDir, ensureDir, parseFlags } from "./utils.js";
import { acquireLock, releaseLock, releaseAllLocks, checkLock, listLocks } from "./lock.js";
import { sendMessage, broadcastMessage, readMessages, listMessages } from "./message.js";
import { addTask, updateTask, getTask, listTasks, setProject, depsReady, type TaskStatus } from "./task.js";
import { setNote, getNote, deleteNote, listNotes } from "./note.js";

const USAGE = `
agent-orchestrator — File locking, messaging & task board for parallel AI agents

INIT
  orch init [--project name]        Create .orch/ in current directory (auto-adds to .gitignore)

LOCKS
  orch lock <path> <agent>          Acquire lock (add --recursive for dirs)
  orch unlock <path> <agent>        Release lock
  orch unlock-all <agent>           Release all locks for an agent
  orch locks                        List all active locks
  orch locked <path>                Check if a path is locked

MESSAGES
  orch send <from> <to> <message>   Send message to an agent
  orch broadcast <from> <message>   Send message to all agents
  orch read <agent>                 Read unread messages for an agent
  orch messages [agent]             List all messages (optionally filtered)

TASKS
  orch task-add <title> <agent>     Add task (--files f1,f2 --desc text --depends-on 1,2)
  orch task-update <id> <status>    Update task status
  orch task-done <id> [result]      Mark task completed (--files-changed f1,f2)
  orch task-fail <id> [reason]      Mark task failed
  orch tasks                        List all tasks (with dependency info)
  orch prompt <id>                  Generate ready-to-paste worker prompt for a task

NOTES
  orch note <key> [value]           Get or set a shared note
  orch note-delete <key>            Delete a shared note
  orch notes                        List all shared notes

OTHER
  orch install                      Symlink agents into ~/.copilot/agents/
  orch status                       Full overview (locks + tasks + messages + notes)
  orch clean                        Remove .orch/ directory

Environment:
  ORCH_DIR    Override .orch/ location (default: $PWD/.orch)
`.trim();

function ok(msg: string) {
  console.log(`✓ ${msg}`);
}
function fail(msg: string) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function need(val: string | undefined, name: string): string {
  if (!val) fail(`Missing required argument: ${name}`);
  return val!;
}

const [command, ...rawArgs] = process.argv.slice(2);
const { positional: args, flags } = parseFlags(rawArgs);

switch (command) {
  // ── Init ──────────────────────────────────────────────
  case "init": {
    const dir = getOrchDir();
    ensureDir(dir);
    ensureDir(`${dir}/locks`);
    ensureDir(`${dir}/messages`);
    ensureDir(`${dir}/tasks`);
    if (flags.project) setProject(flags.project as string);

    // Auto-add .orch/ to .gitignore
    const gitignorePath = resolve(dir, "..", ".gitignore");
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      if (!content.split("\n").some((line) => line.trim() === ".orch/" || line.trim() === ".orch")) {
        appendFileSync(gitignorePath, "\n.orch/\n");
        ok(`Added .orch/ to .gitignore`);
      }
    } else {
      appendFileSync(gitignorePath, ".orch/\n");
      ok(`Created .gitignore with .orch/`);
    }

    ok(`Initialized ${dir}`);
    break;
  }

  // ── Locks ─────────────────────────────────────────────
  case "lock": {
    const path = need(args[0], "path");
    const agent = need(args[1], "agent");
    const recursive = flags.recursive === true;
    const desc = flags.desc as string | undefined;
    const result = acquireLock(path, agent, recursive, desc);
    if (result.ok) {
      ok(`Lock acquired: ${path} → ${agent}${recursive ? " (recursive)" : ""}`);
    } else {
      fail(result.error!);
    }
    break;
  }

  case "unlock": {
    const path = need(args[0], "path");
    const agent = need(args[1], "agent");
    const result = releaseLock(path, agent);
    if (result.ok) ok(`Lock released: ${path}`);
    else fail(result.error!);
    break;
  }

  case "unlock-all": {
    const agent = need(args[0], "agent");
    const count = releaseAllLocks(agent);
    ok(`Released ${count} lock(s) for ${agent}`);
    break;
  }

  case "locks": {
    const locks = listLocks();
    if (locks.length === 0) {
      console.log("No active locks");
    } else {
      console.log(`Active locks (${locks.length}):`);
      for (const l of locks) {
        const rec = l.recursive ? " [recursive]" : "";
        console.log(`  ${l.path} → ${l.agent}${rec} (since ${l.acquiredAt})`);
      }
    }
    break;
  }

  case "locked": {
    const path = need(args[0], "path");
    const lock = checkLock(path);
    if (lock) {
      const rec = lock.recursive ? " (recursive)" : "";
      console.log(`Locked by ${lock.agent}${rec} on ${lock.path}`);
    } else {
      console.log("Not locked");
    }
    break;
  }

  // ── Messages ──────────────────────────────────────────
  case "send": {
    const from = need(args[0], "from");
    const to = need(args[1], "to");
    const content = need(args[2], "message");
    const id = sendMessage(from, to, content);
    ok(`Message sent: ${from} → ${to} (${id})`);
    break;
  }

  case "broadcast": {
    const from = need(args[0], "from");
    const content = need(args[1], "message");
    const id = broadcastMessage(from, content);
    ok(`Broadcast from ${from} (${id})`);
    break;
  }

  case "read": {
    const agent = need(args[0], "agent");
    const msgs = readMessages(agent);
    if (msgs.length === 0) {
      console.log(`No unread messages for ${agent}`);
    } else {
      console.log(`${msgs.length} message(s) for ${agent}:`);
      for (const m of msgs) {
        console.log(`  [${m.id}] ${m.from}: ${m.content}`);
      }
    }
    break;
  }

  case "messages": {
    const agent = args[0];
    const msgs = listMessages(agent);
    if (msgs.length === 0) {
      console.log("No messages");
    } else {
      console.log(`Messages (${msgs.length}):`);
      for (const m of msgs) {
        const read = m.read ? "✓" : "•";
        console.log(`  ${read} [${m.id}] ${m.from} → ${m.to}: ${m.content}`);
      }
    }
    break;
  }

  // ── Tasks ─────────────────────────────────────────────
  case "task-add": {
    const title = need(args[0], "title");
    const agent = need(args[1], "agent");
    const files = flags.files ? (flags.files as string).split(",") : [];
    const desc = flags.desc as string | undefined;
    const dependsOn = flags["depends-on"]
      ? (flags["depends-on"] as string).split(",").map(Number)
      : undefined;
    const id = addTask(title, agent, files, desc, dependsOn);
    const depStr = dependsOn?.length ? ` (depends on: ${dependsOn.join(", ")})` : "";
    ok(`Task #${id} created: "${title}" → ${agent}${depStr}`);
    break;
  }

  case "task-update": {
    const id = Number(need(args[0], "id"));
    const status = need(args[1], "status") as TaskStatus;
    const valid: TaskStatus[] = ["pending", "in-progress", "completed", "failed", "blocked"];
    if (!valid.includes(status)) fail(`Invalid status "${status}". Use: ${valid.join(", ")}`);
    const result = updateTask(id, status);
    if (result.ok) ok(`Task #${id} → ${status}`);
    else fail(result.error!);
    break;
  }

  case "task-done": {
    const id = Number(need(args[0], "id"));
    const result = args[1] || (flags.result as string | undefined);
    const filesChanged = flags["files-changed"]
      ? (flags["files-changed"] as string).split(",")
      : undefined;
    const r = updateTask(id, "completed", result, filesChanged);
    if (r.ok) {
      const parts = [`Task #${id} completed`];
      if (result) parts.push(result);
      if (filesChanged?.length) parts.push(`files: ${filesChanged.join(", ")}`);
      ok(parts.join(" — "));
    } else fail(r.error!);
    break;
  }

  case "task-fail": {
    const id = Number(need(args[0], "id"));
    const reason = args[1];
    const r = updateTask(id, "failed", reason);
    if (r.ok) ok(`Task #${id} failed${reason ? `: ${reason}` : ""}`);
    else fail(r.error!);
    break;
  }

  case "tasks": {
    const tasks = listTasks();
    if (tasks.length === 0) {
      console.log("No tasks");
    } else {
      console.log(`Tasks (${tasks.length}):`);
      for (const t of tasks) {
        const icon =
          t.status === "completed" ? "✓" :
          t.status === "failed" ? "✗" :
          t.status === "in-progress" ? "▶" :
          t.status === "blocked" ? "⊘" : "○";
        const files = t.files.length > 0 ? ` [${t.files.join(", ")}]` : "";
        const deps = t.dependsOn?.length ? ` deps:[${t.dependsOn.join(",")}]` : "";
        let depStatus = "";
        if (t.dependsOn?.length) {
          const { ready, blocking } = depsReady(t);
          depStatus = ready ? " ✓ready" : ` ⊘blocked-by:[${blocking.join(",")}]`;
        }
        const changed = t.filesChanged?.length ? ` changed:[${t.filesChanged.join(", ")}]` : "";
        console.log(`  ${icon} #${t.id} ${t.title} → ${t.agent} (${t.status})${files}${deps}${depStatus}${changed}`);
      }
    }
    break;
  }

  // ── Prompt ────────────────────────────────────────────
  case "prompt": {
    const id = Number(need(args[0], "id"));
    const task = getTask(id);
    if (!task) fail(`Task #${id} not found`);
    const t = task!;
    const dir = getOrchDir();

    // Read template
    const templatePath = join(resolve(import.meta.dirname!, ".."), "templates", "worker.md");
    if (!existsSync(templatePath)) fail(`Template not found: ${templatePath}`);
    let template = readFileSync(templatePath, "utf-8");

    // Substitute placeholders
    template = template.replace(/\{\{ORCH_DIR\}\}/g, dir);
    template = template.replace(/\{\{TASK_ID\}\}/g, String(t.id));
    template = template.replace(/\{\{TASK_TITLE\}\}/g, t.title);
    template = template.replace(/\{\{TASK_FILES\}\}/g, t.files.join(", ") || "(none)");
    template = template.replace(/\{\{TASK_DESCRIPTION\}\}/g, t.description || "(no description)");
    template = template.replace(/\{\{AGENT_ID\}\}/g, t.agent);

    // Add dependency info if present
    if (t.dependsOn?.length) {
      const depInfo = `\n## Dependencies\n\nThis task depends on task(s): ${t.dependsOn.join(", ")}. Ensure they are completed before starting.\n`;
      template = template.replace("## Rules", `${depInfo}\n## Rules`);
    }

    // Add shared notes if any
    const notes = listNotes();
    const noteKeys = Object.keys(notes);
    if (noteKeys.length > 0) {
      let notesSection = "\n## Shared Notes\n\nThese notes were left by the orchestrator or other workers:\n\n";
      for (const key of noteKeys) {
        notesSection += `- **${key}**: ${notes[key].value}\n`;
      }
      template += `\n${notesSection}`;
    }

    console.log(template);
    break;
  }

  // ── Notes ─────────────────────────────────────────────
  case "note": {
    const key = need(args[0], "key");
    if (args[1] !== undefined) {
      const agent = flags.agent as string | undefined;
      setNote(key, args[1], agent);
      ok(`Note "${key}" set`);
    } else {
      const entry = getNote(key);
      if (entry) {
        const by = entry.updatedBy ? ` (by ${entry.updatedBy})` : "";
        console.log(`${key}: ${entry.value}${by}`);
      } else {
        console.log(`Note "${key}" not found`);
      }
    }
    break;
  }

  case "notes": {
    const notes = listNotes();
    const keys = Object.keys(notes);
    if (keys.length === 0) {
      console.log("No shared notes");
    } else {
      console.log(`Shared notes (${keys.length}):`);
      for (const key of keys) {
        const n = notes[key];
        const by = n.updatedBy ? ` (by ${n.updatedBy})` : "";
        console.log(`  ${key}: ${n.value}${by}`);
      }
    }
    break;
  }

  case "note-delete": {
    const key = need(args[0], "key");
    const deleted = deleteNote(key);
    if (deleted) ok(`Note "${key}" deleted`);
    else console.log(`Note "${key}" not found`);
    break;
  }

  // ── Status ────────────────────────────────────────────
  case "status": {
    const dir = getOrchDir();
    if (!existsSync(dir)) {
      fail(`No .orch/ found. Run: orch init`);
    }
    const locks = listLocks();
    const tasks = listTasks();
    const msgs = listMessages();
    const notes = listNotes();

    console.log(`=== Orchestrator Status (${dir}) ===\n`);

    console.log(`Locks: ${locks.length}`);
    for (const l of locks) {
      console.log(`  ${l.path} → ${l.agent}${l.recursive ? " [recursive]" : ""}`);
    }

    console.log(`\nTasks: ${tasks.length}`);
    const byStatus = { pending: 0, "in-progress": 0, completed: 0, failed: 0, blocked: 0 };
    for (const t of tasks) byStatus[t.status]++;
    console.log(`  pending: ${byStatus.pending}, in-progress: ${byStatus["in-progress"]}, completed: ${byStatus.completed}, failed: ${byStatus.failed}, blocked: ${byStatus.blocked}`);
    const blockedTasks = tasks.filter((t) => t.dependsOn?.length && !depsReady(t).ready);
    if (blockedTasks.length > 0) {
      console.log(`  blocked by dependencies: ${blockedTasks.map((t) => `#${t.id}`).join(", ")}`);
    }
    for (const t of tasks) {
      const deps = t.dependsOn?.length ? ` deps:[${t.dependsOn.join(",")}]` : "";
      console.log(`  #${t.id} ${t.title} → ${t.agent} (${t.status})${deps}`);
    }

    const unread = msgs.filter((m) => !m.read);
    console.log(`\nMessages: ${msgs.length} total, ${unread.length} unread`);

    const noteKeys = Object.keys(notes);
    console.log(`\nNotes: ${noteKeys.length}`);
    for (const key of noteKeys) {
      console.log(`  ${key}: ${notes[key].value}`);
    }

    break;
  }

  // ── Install ───────────────────────────────────────────
  case "install": {
    const home = process.env.HOME;
    if (!home) { fail("HOME not set"); break; }

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const agentsSrc = resolve(__dirname, "..", "agents");
    const agentsDst = join(home, ".copilot", "agents");
    ensureDir(agentsDst);

    if (!existsSync(agentsSrc)) { fail(`No agents directory at ${agentsSrc}`); break; }

    const files = readdirSync(agentsSrc).filter(f => f.endsWith(".agent.md"));
    if (files.length === 0) { fail("No .agent.md files found"); break; }

    for (const file of files) {
      const src = join(agentsSrc, file);
      const dst = join(agentsDst, file);

      // Remove existing symlink for idempotency
      if (existsSync(dst)) {
        const stat = lstatSync(dst);
        if (stat.isSymbolicLink()) {
          unlinkSync(dst);
        } else {
          console.log(`  ⚠ Skipping ${file} — regular file exists at ${dst}`);
          continue;
        }
      }

      symlinkSync(src, dst);
      console.log(`  ✓ ${file} → ${src}`);
    }

    ok(`Installed ${files.length} agent(s) into ${agentsDst}`);
    break;
  }

  // ── Clean ─────────────────────────────────────────────
  case "clean": {
    const dir = getOrchDir();
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
      ok(`Removed ${dir}`);
    } else {
      console.log("Nothing to clean");
    }
    break;
  }

  // ── Help ──────────────────────────────────────────────
  case "help":
  case "--help":
  case "-h":
  case undefined:
    console.log(USAGE);
    break;

  default:
    fail(`Unknown command: ${command}\n\n${USAGE}`);
}
