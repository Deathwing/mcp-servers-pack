import { join } from "node:path";
import { getOrchDir, readJson, writeJson, timestamp } from "./utils.js";

interface NoteEntry {
  value: string;
  updatedAt: string;
  updatedBy?: string;
}

type NotesStore = Record<string, NoteEntry>;

function notesPath(): string {
  return join(getOrchDir(), "notes.json");
}

function loadNotes(): NotesStore {
  return readJson<NotesStore>(notesPath(), {});
}

export function setNote(key: string, value: string, agent?: string): void {
  const notes = loadNotes();
  notes[key] = { value, updatedAt: timestamp(), updatedBy: agent };
  writeJson(notesPath(), notes);
}

export function getNote(key: string): NoteEntry | null {
  return loadNotes()[key] ?? null;
}

export function deleteNote(key: string): boolean {
  const notes = loadNotes();
  if (!(key in notes)) return false;
  delete notes[key];
  writeJson(notesPath(), notes);
  return true;
}

export function listNotes(): NotesStore {
  return loadNotes();
}
