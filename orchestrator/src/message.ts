import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { getOrchDir, ensureDir, readJson, writeJson, timestamp, genId } from "./utils.js";

export interface Message {
  id: string;
  from: string;
  to: string; // agent id or "all" for broadcast
  content: string;
  read: boolean;
  createdAt: string;
}

function msgsDir(): string {
  const dir = join(getOrchDir(), "messages");
  ensureDir(dir);
  return dir;
}

function allMessages(): Message[] {
  const dir = msgsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort() // timestamp-prefixed filenames → chronological order
    .map((f) => readJson<Message>(join(dir, f), null as unknown as Message))
    .filter(Boolean);
}

export function sendMessage(from: string, to: string, content: string): string {
  const id = genId();
  const msg: Message = {
    id,
    from,
    to,
    content,
    read: false,
    createdAt: timestamp(),
  };
  const filename = `${msg.createdAt.replace(/[:.]/g, "-")}-${id}.json`;
  writeJson(join(msgsDir(), filename), msg);
  return id;
}

export function broadcastMessage(from: string, content: string): string {
  return sendMessage(from, "all", content);
}

export function readMessages(agent: string): Message[] {
  const dir = msgsDir();
  const unread: Message[] = [];

  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const filePath = join(dir, f);
    const msg = readJson<Message>(filePath, null as unknown as Message);
    if (!msg) continue;
    if (msg.read) continue;
    if (msg.to !== agent && msg.to !== "all") continue;

    msg.read = true;
    writeJson(filePath, msg);
    unread.push(msg);
  }

  return unread;
}

export function listMessages(agent?: string): Message[] {
  const all = allMessages();
  if (!agent) return all;
  return all.filter((m) => m.from === agent || m.to === agent || m.to === "all");
}
