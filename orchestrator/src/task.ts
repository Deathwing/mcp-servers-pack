import { join } from "node:path";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { getOrchDir, ensureDir, readJson, writeJson, timestamp } from "./utils.js";

export type TaskStatus = "pending" | "in-progress" | "completed" | "failed" | "blocked";

export interface Task {
  id: number;
  title: string;
  agent: string;
  status: TaskStatus;
  files: string[];
  description?: string;
  dependsOn?: number[];
  result?: string;
  filesChanged?: string[];
  createdAt: string;
  updatedAt: string;
}

interface TaskMeta {
  project: string;
  createdAt: string;
}

function tasksDir(): string {
  const dir = join(getOrchDir(), "tasks");
  ensureDir(dir);
  return dir;
}

function metaPath(): string {
  return join(getOrchDir(), "tasks_meta.json");
}

function taskFile(id: number): string {
  return join(tasksDir(), `${id}.json`);
}

function loadMeta(): TaskMeta {
  return readJson<TaskMeta>(metaPath(), { project: "", createdAt: timestamp() });
}

function loadAllTasks(): Task[] {
  const dir = tasksDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => readJson<Task>(join(dir, f), null as unknown as Task))
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);
}

function computeNextId(): number {
  const tasks = loadAllTasks();
  return tasks.length > 0 ? Math.max(...tasks.map((t) => t.id)) + 1 : 1;
}

export function addTask(
  title: string,
  agent: string,
  files: string[] = [],
  description?: string,
  dependsOn?: number[],
): number {
  let nextId = computeNextId();
  const now = timestamp();
  const maxRetries = 20;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const task: Task = {
      id: nextId,
      title,
      agent,
      status: "pending",
      files,
      description,
      dependsOn: dependsOn?.length ? dependsOn : undefined,
      createdAt: now,
      updatedAt: now,
    };
    try {
      // Atomic exclusive create — fails if another agent took this ID
      writeFileSync(taskFile(nextId), JSON.stringify(task, null, 2) + "\n", { flag: "wx" });
      return nextId;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        nextId++;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to allocate task ID after ${maxRetries} retries`);
}

export function updateTask(
  id: number,
  status: TaskStatus,
  result?: string,
  filesChanged?: string[],
): { ok: boolean; error?: string } {
  const file = taskFile(id);
  const task = readJson<Task>(file, null as unknown as Task);
  if (!task) return { ok: false, error: `Task ${id} not found` };

  task.status = status;
  task.updatedAt = timestamp();
  if (result !== undefined) task.result = result;
  if (filesChanged?.length) task.filesChanged = filesChanged;
  writeJson(file, task);
  return { ok: true };
}

export function depsReady(task: Task): { ready: boolean; blocking: number[] } {
  if (!task.dependsOn?.length) return { ready: true, blocking: [] };
  const blocking: number[] = [];
  for (const depId of task.dependsOn) {
    const dep = readJson<Task>(taskFile(depId), null as unknown as Task);
    if (!dep || dep.status !== "completed") blocking.push(depId);
  }
  return { ready: blocking.length === 0, blocking };
}

export function getTask(id: number): Task | null {
  return readJson<Task>(taskFile(id), null as unknown as Task);
}

export function listTasks(): Task[] {
  return loadAllTasks();
}

export function setProject(name: string): void {
  const meta = loadMeta();
  meta.project = name;
  writeJson(metaPath(), meta);
}
