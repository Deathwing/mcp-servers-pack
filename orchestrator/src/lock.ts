import { join } from "node:path";
import { existsSync, readdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { getOrchDir, ensureDir, readJson, sanitizePath, timestamp } from "./utils.js";

export interface Lock {
  path: string;
  agent: string;
  recursive: boolean;
  acquiredAt: string;
  description?: string;
}

function locksDir(): string {
  const dir = join(getOrchDir(), "locks");
  ensureDir(dir);
  return dir;
}

function lockFile(normalizedPath: string): string {
  return join(locksDir(), `${sanitizePath(normalizedPath)}.json`);
}

function allLocks(): Lock[] {
  const dir = locksDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Lock>(join(dir, f), null as unknown as Lock))
    .filter(Boolean);
}

function normalize(p: string): string {
  return p.replace(/\/+$/, "");
}

export function acquireLock(
  path: string,
  agent: string,
  recursive = false,
  description?: string,
): { ok: boolean; error?: string } {
  const np = normalize(path);
  const locks = allLocks();

  for (const lock of locks) {
    const lp = normalize(lock.path);

    // Exact match
    if (lp === np) {
      if (lock.agent === agent) return { ok: true }; // re-acquire own lock
      return { ok: false, error: `"${path}" already locked by ${lock.agent}` };
    }

    // Existing parent recursive lock covers this path
    if (lock.recursive && np.startsWith(`${lp}/`)) {
      if (lock.agent === agent) return { ok: true };
      return { ok: false, error: `"${path}" covered by recursive lock on "${lock.path}" (${lock.agent})` };
    }

    // New recursive lock would cover existing child lock
    if (recursive && lp.startsWith(`${np}/`)) {
      if (lock.agent !== agent) {
        return { ok: false, error: `Recursive lock on "${path}" conflicts with "${lock.path}" (${lock.agent})` };
      }
    }
  }

  const lock: Lock = { path: np, agent, recursive, acquiredAt: timestamp(), description };
  const file = lockFile(np);
  try {
    // Atomic exclusive create — fails if another agent won the race
    writeFileSync(file, JSON.stringify(lock, null, 2) + "\n", { flag: "wx" });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Another agent created the lock between our check and our write
      try {
        const existing: Lock = JSON.parse(readFileSync(file, "utf-8"));
        if (existing.agent === agent) return { ok: true }; // re-entrant
        return { ok: false, error: `"${path}" already locked by ${existing.agent} (race)` };
      } catch {
        return { ok: false, error: `"${path}" lock file exists but unreadable (race)` };
      }
    }
    throw err;
  }
  return { ok: true };
}

export function releaseLock(path: string, agent: string): { ok: boolean; error?: string } {
  const np = normalize(path);
  const file = lockFile(np);
  if (!existsSync(file)) return { ok: false, error: `No lock on "${path}"` };

  const lock = readJson<Lock>(file, null as unknown as Lock);
  if (lock.agent !== agent) {
    return { ok: false, error: `"${path}" owned by ${lock.agent}, not ${agent}` };
  }
  unlinkSync(file);
  return { ok: true };
}

export function releaseAllLocks(agent: string): number {
  let count = 0;
  for (const lock of allLocks()) {
    if (lock.agent === agent) {
      const file = lockFile(normalize(lock.path));
      if (existsSync(file)) {
        unlinkSync(file);
        count++;
      }
    }
  }
  return count;
}

export function checkLock(path: string): Lock | null {
  const np = normalize(path);
  for (const lock of allLocks()) {
    const lp = normalize(lock.path);
    if (lp === np) return lock;
    if (lock.recursive && np.startsWith(`${lp}/`)) return lock;
  }
  return null;
}

export function listLocks(): Lock[] {
  return allLocks();
}
