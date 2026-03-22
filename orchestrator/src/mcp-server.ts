#!/usr/bin/env node
/**
 * Orchestrator MCP Server
 *
 * Exposes the agent-orchestrator CLI as MCP tools so any Copilot agent
 * can manage parallel worker sub-processes without writing bash commands.
 *
 * Tools:
 *   orchestrate_work  — One-shot: init, add tasks, spawn workers, wait, return logs
 *   spawn_workers     — Low-level: spawn N copilot CLI workers
 *   orch_status       — Read current .orch/ status (tasks, locks, notes, messages)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, openSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ── helpers ──────────────────────────────────────────────────────────

const COPILOT_BIN = "copilot";

function orchCmd(orchDir: string, args: string): string {
  const prefix = resolve(process.env.HOME ?? "~", ".mcp-servers/orchestrator");
  const cli = join(prefix, "src/cli.ts");
  return execSync(`ORCH_DIR="${orchDir}" npx --prefix "${prefix}" tsx "${cli}" ${args}`, {
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, ORCH_DIR: orchDir },
  }).trim();
}

function readLogSafe(path: string, tailLines = 80): string {
  if (!existsSync(path)) return "(no output)";
  const lines = readFileSync(path, "utf-8").split("\n");
  const tail = lines.slice(-tailLines).join("\n");
  return tail || "(empty)";
}

function detectCopilotBin(): string {
  try {
    return execSync("which copilot", { encoding: "utf-8" }).trim();
  } catch {
    // Fallback to common NVM location
    const nvm = resolve(process.env.HOME ?? "~", ".nvm/versions/node");
    if (existsSync(nvm)) {
      try {
        const found = execSync(`find "${nvm}" -name copilot -type f 2>/dev/null | head -1`, {
          encoding: "utf-8",
        }).trim();
        if (found) return found;
      } catch { /* ignore */ }
    }
    return COPILOT_BIN;
  }
}

// ── process tracking ─────────────────────────────────────────────────

/** Map: orchestrationId → Set of active ChildProcess objects */
const activeProcesses = new Map<string, Set<ChildProcess>>();

function trackProcess(orchId: string, proc: ChildProcess): void {
  if (!activeProcesses.has(orchId)) activeProcesses.set(orchId, new Set());
  activeProcesses.get(orchId)!.add(proc);
}

function untrackProcess(orchId: string, proc: ChildProcess): void {
  activeProcesses.get(orchId)?.delete(proc);
  if (activeProcesses.get(orchId)?.size === 0) activeProcesses.delete(orchId);
}

function killOrchestration(orchId: string): number {
  const procs = activeProcesses.get(orchId);
  if (!procs) return 0;
  let killed = 0;
  for (const proc of procs) {
    try { proc.kill("SIGTERM"); killed++; } catch { /* already dead */ }
  }
  activeProcesses.delete(orchId);
  return killed;
}

function killAllOrchestrations(): void {
  for (const [, procs] of activeProcesses) {
    for (const proc of procs) {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }
  activeProcesses.clear();
}

// Cleanup all child processes on shutdown
process.on("SIGTERM", () => { killAllOrchestrations(); process.exit(0); });
process.on("SIGINT", () => { killAllOrchestrations(); process.exit(0); });

// ── server setup ─────────────────────────────────────────────────────

const server = new McpServer({
  name: "orchestrator",
  version: "1.0.0",
});

// ── tool: orchestrate_goal ────────────────────────────────────────────

server.tool(
  "orchestrate_goal",
  `Autonomous goal-based orchestration.

Takes a high-level goal and spawns an Orchestrator agent that autonomously
decomposes it into parallel subtasks, spawns Worker agents, and manages the
full lifecycle (planning, execution, verification).

Use this when you want the AI to figure out task decomposition.
For explicit pre-planned tasks, use orchestrate_work instead.`,
  {
    goal: z.string().describe("High-level goal description. What should be accomplished?"),
    workDir: z.string().describe("Absolute path to the working directory for the orchestrator and its workers"),
    model: z.string().optional().describe("Model ID to pass to the orchestrator agent. Omit to inherit the default model."),
    context: z.string().optional().describe("Additional context the orchestrator should know (project conventions, constraints, file structure, etc.)"),
    maxWorkers: z.number().optional().describe("Hint for max workers the orchestrator should spawn (default: let orchestrator decide)"),
    timeoutSeconds: z.number().optional().describe("Max seconds to wait for the orchestrator to finish (default: 600)"),
  },
  async ({ goal, workDir, model, context, maxWorkers, timeoutSeconds }) => {
    const timeout = (timeoutSeconds ?? 600) * 1000;
    const logPath = join(tmpdir(), `orchestrate-goal-${randomUUID().slice(0, 8)}.log`);
    const copilotBin = detectCopilotBin();
    mkdirSync(workDir, { recursive: true });

    // Build the orchestrator prompt — self-contained, single-line
    const parts = [
      `Goal: ${goal}`,
      `Work directory: ${workDir}`,
    ];
    if (context) parts.push(`Context: ${context}`);
    if (maxWorkers) parts.push(`Spawn at most ${maxWorkers} workers total.`);
    parts.push(
      `You are an autonomous orchestrator. Analyze this goal, decompose it into parallel worker tasks, spawn workers, wait for them, verify results, and report back.`,
      `Use the orch CLI as described in your agent instructions. The workers should use --add-dir "${workDir}".`,
      `At the end, output a clear summary: what was accomplished, which files were changed, and any issues.`,
    );

    const safePrompt = parts.join(" ").replace(/'/g, "'\\''");

    const args = [
      "--agent", "Orchestrator",
      ...(model ? ["--model", model] : []),
      "--yolo",
      "--add-dir", workDir,
      "-s",
      "-p", safePrompt,
    ];

    const logFd = openSync(logPath, "w");
    const orchId = `goal-${randomUUID().slice(0, 8)}`;

    try {
      const proc = spawn(copilotBin, args, {
        stdio: ["pipe", logFd, logFd],
        detached: false,
        cwd: workDir,
      });
      proc.stdin?.end();
      trackProcess(orchId, proc);
      const startedAt = Date.now();

      await new Promise<void>((res) => {
        const timer = setTimeout(() => {
          proc.kill("SIGTERM");
          untrackProcess(orchId, proc);
          res();
        }, timeout);
        proc.on("exit", () => {
          clearTimeout(timer);
          untrackProcess(orchId, proc);
          try { closeSync(logFd); } catch { /* already closed */ }
          res();
        });
        proc.on("error", (err) => {
          clearTimeout(timer);
          untrackProcess(orchId, proc);
          try { closeSync(logFd); } catch { /* already closed */ }
          writeFileSync(logPath, `\n[orchestrate_goal] Spawn error: ${err.message}\n`, { flag: "a" });
          res();
        });
      });

      const durationMs = Date.now() - startedAt;
      const output = readLogSafe(logPath, 200);

      return {
        content: [
          {
            type: "text" as const,
            text: `# Orchestrate Goal Complete\n\n**Goal:** ${goal}\n**Work Dir:** ${workDir}\n**Duration:** ${(durationMs / 1000).toFixed(1)}s\n\n---\n\n${output}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Orchestrate goal failed: ${err}` }],
        isError: true,
      };
    }
  },
);

// ── tool: orchestrate_work ───────────────────────────────────────────

server.tool(
  "orchestrate_work",
  `Pre-planned parallel work execution.

Takes an explicit list of worker tasks, spawns them as parallel Copilot CLI
workers, waits for completion, and returns all worker logs.

Use this when YOU have already decomposed the goal into specific tasks.
For autonomous planning, use orchestrate_goal instead — it spawns an
Orchestrator agent that figures out the task breakdown itself.

Each task has a title, prompt, and optional file scope. Use 'wave' to
serialize groups. Use 'maxConcurrent' to throttle parallelism (default 10).`,
  {
    project: z.string().describe("Short project name for .orch/ init"),
    workDir: z.string().describe("Absolute path to the working directory for workers"),
    model: z.string().optional().describe("Model ID to pass to copilot CLI. Omit to inherit the default model."),
    tasks: z
      .array(
        z.object({
          title: z.string().describe("Short task title"),
          prompt: z.string().describe("Full self-contained prompt for the worker. Must be a single line — no literal newlines. Use double quotes inside."),
          files: z.string().optional().describe("Files/dirs this task owns (comma-separated)"),
          wave: z.number().optional().describe("Wave number (0-based). Tasks in the same wave run in parallel. Higher waves wait for lower waves. Default: 0"),
        }),
      )
      .min(1)
      .describe("Worker tasks to execute"),
    notes: z
      .record(z.string(), z.string())
      .optional()
      .describe("Shared notes visible to all workers (key→value map)"),
    maxConcurrent: z
      .number()
      .optional()
      .describe("Max workers to run simultaneously per wave (default: 10). Use to avoid resource exhaustion with large worker counts."),
    timeoutSeconds: z
      .number()
      .optional()
      .describe("Max seconds to wait for all workers (default: 300)"),
    workerTimeoutSeconds: z
      .number()
      .optional()
      .describe("Max seconds per individual worker before it's killed (default: same as timeoutSeconds)"),
  },
  async ({ project, workDir, model, tasks, notes, maxConcurrent, timeoutSeconds, workerTimeoutSeconds }) => {
    const workerTimeout = (workerTimeoutSeconds ?? timeoutSeconds ?? 300) * 1000;
    const orchId = `work-${randomUUID().slice(0, 8)}`;
    const totalStart = Date.now();
    const orchDir = join(tmpdir(), `orch-${randomUUID().slice(0, 8)}`);
    const logDir = join(tmpdir(), `orch-logs-${randomUUID().slice(0, 8)}`);
    mkdirSync(logDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    const copilotBin = detectCopilotBin();

    try {
      // Init
      orchCmd(orchDir, `init --project "${project}"`);

      // Add shared notes
      if (notes) {
        for (const [key, value] of Object.entries(notes)) {
          orchCmd(orchDir, `note "${key}" "${(value as string).replace(/"/g, '\\"')}"`);
        }
      }

      // Add tasks
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const filesFlag = t.files ? ` --files "${t.files}"` : "";
        orchCmd(orchDir, `task-add "${t.title}" worker-${i + 1}${filesFlag} --desc "${t.prompt.slice(0, 200).replace(/"/g, '\\"')}"`);
      }

      // Group tasks by wave
      const waves = new Map<number, { index: number; task: typeof tasks[0] }[]>();
      for (let i = 0; i < tasks.length; i++) {
        const wave = tasks[i].wave ?? 0;
        if (!waves.has(wave)) waves.set(wave, []);
        waves.get(wave)!.push({ index: i, task: tasks[i] });
      }
      const sortedWaves = [...waves.keys()].sort((a, b) => a - b);

      const allLogs: string[] = [];

      // Execute waves sequentially, tasks within a wave in parallel (throttled)
      for (const waveNum of sortedWaves) {
        const waveTasks = waves.get(waveNum)!;
        const concurrency = maxConcurrent ?? 10;

        // Split wave into batches of maxConcurrent
        for (let batchStart = 0; batchStart < waveTasks.length; batchStart += concurrency) {
          const batch = waveTasks.slice(batchStart, batchStart + concurrency);
          const procs: { proc: ChildProcess; logPath: string; logFd: number; index: number; title: string; startedAt: number }[] = [];

          for (const { index, task } of batch) {
            const taskId = index + 1;
            const logPath = join(logDir, `worker-${taskId}.log`);

            // Build the orch helper for the worker prompt
            const orchSetup = `orch() { ORCH_DIR="${orchDir}" npx --prefix "$HOME/.mcp-servers/orchestrator" tsx "$HOME/.mcp-servers/orchestrator/src/cli.ts" "$@"; }`;
            const orchSteps = `orch task-update ${taskId} in-progress; <DO WORK>; orch task-done ${taskId} --result "summary"`;

            // Sanitize prompt: no single quotes (would break outer quoting)
            const safePrompt = task.prompt.replace(/'/g, "'\\''");
            const fullPrompt = `${safePrompt} --- Orchestrator setup: ${orchSetup} --- Steps: ${orchSteps}`;

            const args = [
              "--agent", "Worker",
              ...(model ? ["--model", model] : []),
              "--yolo",
              "--add-dir", workDir,
              "-s",
              "-p", fullPrompt,
            ];

            const logFd = openSync(logPath, "w");
            const proc = spawn(copilotBin, args, {
              stdio: ["pipe", logFd, logFd],
              detached: false,
              cwd: workDir,
            });
            proc.stdin?.end();
            trackProcess(orchId, proc);

            procs.push({ proc, logPath, logFd, index, title: task.title, startedAt: Date.now() });
          }

          // Wait for all processes in this batch
          await Promise.all(
            procs.map(
              ({ proc, logPath, logFd, index, title }) =>
                new Promise<void>((res) => {
                  const timer = setTimeout(() => {
                    proc.kill("SIGTERM");
                    writeFileSync(logPath, `\n[orchestrator] Worker "${title}" timed out after ${workerTimeout / 1000}s\n`, { flag: "a" });
                    try { orchCmd(orchDir, `task-fail ${index + 1} --reason "Timed out after ${workerTimeout / 1000}s"`); } catch { /* best effort */ }
                    untrackProcess(orchId, proc);
                    res();
                  }, workerTimeout);
                  proc.on("exit", (code) => {
                    clearTimeout(timer);
                    untrackProcess(orchId, proc);
                    try { closeSync(logFd); } catch { /* already closed */ }
                    if (code !== 0 && code !== null) {
                      writeFileSync(logPath, `\n[orchestrator] Worker "${title}" exited with code ${code}\n`, { flag: "a" });
                      try { orchCmd(orchDir, `task-fail ${index + 1} --reason "Process exited with code ${code}"`); } catch { /* best effort */ }
                    }
                    res();
                  });
                  proc.on("error", (err) => {
                    clearTimeout(timer);
                    untrackProcess(orchId, proc);
                    try { closeSync(logFd); } catch { /* already closed */ }
                    writeFileSync(logPath, `\n[orchestrator] Spawn error for "${title}": ${err.message}\n`, { flag: "a" });
                    try { orchCmd(orchDir, `task-fail ${index + 1} --reason "Spawn error: ${err.message}"`); } catch { /* best effort */ }
                    res();
                  });
                }),
            ),
          );

          // Collect logs for this batch
          for (const { logPath, index, title, startedAt } of procs) {
            const durationMs = Date.now() - startedAt;
            const log = readLogSafe(logPath);
            allLogs.push(`## Worker ${index + 1}: ${title} (${(durationMs / 1000).toFixed(1)}s)\n\n${log}`);
          }
        }
      }

      // Final status
      let status = "";
      try {
        status = orchCmd(orchDir, "status");
      } catch { status = "(could not read status)"; }

      // Cleanup .orch
      try { rmSync(orchDir, { recursive: true, force: true }); } catch { /* ignore */ }

      return {
        content: [
          {
            type: "text" as const,
            text: `# Orchestration Complete\n\n**Project:** ${project}\n**Workers:** ${tasks.length}\n**Waves:** ${sortedWaves.length}\n**Total Duration:** ${((Date.now() - totalStart) / 1000).toFixed(1)}s\n\n---\n\n${allLogs.join("\n\n---\n\n")}\n\n---\n\n## Orchestrator Status\n\n${status}`,
          },
        ],
      };
    } catch (err) {
      // Cleanup on error
      try { rmSync(orchDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return {
        content: [{ type: "text" as const, text: `Orchestration failed: ${err}` }],
        isError: true,
      };
    }
  },
);

// ── tool: spawn_workers ──────────────────────────────────────────────

server.tool(
  "spawn_workers",
  `Spawn parallel Copilot CLI workers and wait for completion.

Lower-level than orchestrate_work — you manage .orch/ yourself.
This just handles process spawning with correct flags and log collection.`,
  {
    workDir: z.string().describe("Absolute path to the working directory"),
    model: z.string().optional().describe("Model ID to pass to copilot CLI. Omit to inherit the default model."),
    workers: z
      .array(
        z.object({
          prompt: z.string().describe("Full single-line prompt for the worker"),
        }),
      )
      .min(1)
      .describe("Workers to spawn in parallel"),
    timeoutSeconds: z
      .number()
      .optional()
      .describe("Max seconds to wait (default: 300)"),
    workerTimeoutSeconds: z
      .number()
      .optional()
      .describe("Max seconds per individual worker before it's killed (default: same as timeoutSeconds)"),
  },
  async ({ workDir, model, workers, timeoutSeconds, workerTimeoutSeconds }) => {
    const workerTimeout = (workerTimeoutSeconds ?? timeoutSeconds ?? 300) * 1000;
    const orchId = `spawn-${randomUUID().slice(0, 8)}`;
    const totalStart = Date.now();
    const logDir = join(tmpdir(), `spawn-logs-${randomUUID().slice(0, 8)}`);
    mkdirSync(logDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    const copilotBin = detectCopilotBin();

    const procs: { proc: ChildProcess; logPath: string; logFd: number; index: number; startedAt: number }[] = [];

    for (let i = 0; i < workers.length; i++) {
      const logPath = join(logDir, `worker-${i + 1}.log`);
      const safePrompt = workers[i].prompt.replace(/'/g, "'\\''");

      const args = [
        "--agent", "Worker",
        ...(model ? ["--model", model] : []),
        "--yolo",
        "--add-dir", workDir,
        "-s",
        "-p", safePrompt,
      ];

      const logFd = openSync(logPath, "w");
      const proc = spawn(copilotBin, args, {
        stdio: ["pipe", logFd, logFd],
        detached: false,
        cwd: workDir,
      });
      proc.stdin?.end();
      trackProcess(orchId, proc);

      procs.push({ proc, logPath, logFd, index: i, startedAt: Date.now() });
    }

    // Wait
    await Promise.all(
      procs.map(
        ({ proc, logPath, logFd, index }) =>
          new Promise<void>((res) => {
            const timer = setTimeout(() => {
              proc.kill("SIGTERM");
              writeFileSync(logPath, `\n[orchestrator] Worker ${index + 1} timed out after ${workerTimeout / 1000}s\n`, { flag: "a" });
              untrackProcess(orchId, proc);
              res();
            }, workerTimeout);
            proc.on("exit", (code) => {
              clearTimeout(timer);
              untrackProcess(orchId, proc);
              try { closeSync(logFd); } catch { /* already closed */ }
              if (code !== 0 && code !== null) {
                writeFileSync(logPath, `\n[orchestrator] Worker ${index + 1} exited with code ${code}\n`, { flag: "a" });
              }
              res();
            });
            proc.on("error", (err) => {
              clearTimeout(timer);
              untrackProcess(orchId, proc);
              try { closeSync(logFd); } catch { /* already closed */ }
              writeFileSync(logPath, `\n[orchestrator] Spawn error for worker ${index + 1}: ${err.message}\n`, { flag: "a" });
              res();
            });
          }),
      ),
    );

    const logs = procs.map(({ logPath, index, startedAt }) => {
      const durationMs = Date.now() - startedAt;
      const log = readLogSafe(logPath);
      return `## Worker ${index + 1} (${(durationMs / 1000).toFixed(1)}s)\n\n${log}`;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `# Workers Complete\n\n**Count:** ${workers.length}\n**Total Duration:** ${((Date.now() - totalStart) / 1000).toFixed(1)}s\n\n---\n\n${logs.join("\n\n---\n\n")}`,
        },
      ],
    };
  },
);

// ── tool: cancel_orchestration ───────────────────────────────────────

server.tool(
  "cancel_orchestration",
  `Cancel a running orchestration by killing all its tracked worker processes.

Supports a special "all" ID to kill every active orchestration.
Use orch_status to see active orchestration IDs.`,
  {
    orchestrationId: z
      .string()
      .describe('Orchestration ID to cancel, or "all" to kill every active orchestration'),
  },
  async ({ orchestrationId }) => {
    if (orchestrationId === "all") {
      let total = 0;
      for (const [, procs] of activeProcesses) total += procs.size;
      killAllOrchestrations();
      return {
        content: [{ type: "text" as const, text: `Killed all active orchestrations (${total} processes).` }],
      };
    }
    const killed = killOrchestration(orchestrationId);
    if (killed === 0) {
      return {
        content: [{ type: "text" as const, text: `No active processes found for orchestration "${orchestrationId}". It may have already completed.` }],
      };
    }
    return {
      content: [{ type: "text" as const, text: `Cancelled orchestration "${orchestrationId}": killed ${killed} worker process(es).` }],
    };
  },
);

// ── tool: orch_status ────────────────────────────────────────────────

server.tool(
  "orch_status",
  "Read the current orchestrator status — tasks, locks, notes, and messages from the .orch/ directory.",
  {
    orchDir: z
      .string()
      .optional()
      .describe("Path to .orch/ directory (default: $PWD/.orch)"),
  },
  async ({ orchDir }) => {
    // Active process summary
    let processInfo = "";
    if (activeProcesses.size > 0) {
      const entries = [...activeProcesses.entries()].map(([id, procs]) => `  ${id}: ${procs.size} worker(s)`);
      processInfo = `**Active Orchestrations:**\n${entries.join("\n")}\n\n`;
    }

    const dir = orchDir ?? resolve(process.cwd(), ".orch");
    if (!existsSync(dir)) {
      return {
        content: [{ type: "text" as const, text: processInfo || "No .orch/ directory found and no active orchestrations." }],
      };
    }
    try {
      const status = orchCmd(dir, "status");
      return { content: [{ type: "text" as const, text: `${processInfo}${status}` }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error reading status: ${err}` }],
        isError: true,
      };
    }
  },
);

// ── start ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Orchestrator MCP server error: ${err}\n`);
  process.exit(1);
});
