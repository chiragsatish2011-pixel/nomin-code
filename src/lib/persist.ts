import type { Plan, PlanStatus } from "../model/plan.js";
import type { ChatMessage } from "./useAgent.js";

/**
 * Durable session state.
 *
 * A rate limit already survives inside a turn; this is what makes the *task*
 * survive a reload. Everything needed to pick the work back up is written as
 * one record per session: the conversation, the events behind it, the approved
 * plan and where execution had reached.
 *
 * IndexedDB rather than localStorage, because a session with a few builds in
 * it is megabytes, and a quota error mid-build would lose exactly the work
 * this exists to protect. Every access is guarded: with storage blocked the
 * app still runs, it simply forgets.
 */

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  plan: Plan | null;
  planStatus: PlanStatus;
  /** Which plan step execution had reached, for resuming mid-build. */
  step: number;
  mode: string;
}

const DB_NAME = "nomin";
const DB_VERSION = 1;
const STORE = "sessions";
const LAST_KEY = "nomin.lastSession";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function transact<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveSession(record: SessionRecord): Promise<void> {
  await transact("readwrite", (store) => store.put(record));
  try {
    localStorage.setItem(LAST_KEY, record.id);
  } catch {
    /* the session still saved; only the pointer is lost */
  }
}

export async function loadSession(id: string): Promise<SessionRecord | null> {
  return (await transact<SessionRecord>("readonly", (store) => store.get(id))) ?? null;
}

/** The session to restore on open, if there is one worth restoring. */
export async function loadLastSession(): Promise<SessionRecord | null> {
  let id: string | null = null;
  try {
    id = localStorage.getItem(LAST_KEY);
  } catch {
    id = null;
  }
  if (id) {
    const record = await loadSession(id);
    if (record?.messages.length) return record;
  }
  const all = await listSessions();
  return all[0]?.messages.length ? all[0] : null;
}

/** Newest first. */
export async function listSessions(): Promise<SessionRecord[]> {
  const all = await transact<SessionRecord[]>("readonly", (store) => store.getAll());
  return (all ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSession(id: string): Promise<void> {
  await transact("readwrite", (store) => store.delete(id));
}

export const newSessionId = () =>
  `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A short, honest title: the first line of what was asked for. */
export function titleFor(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  if (!first) return "New session";
  return first.content.split("\n")[0]?.slice(0, 60) || "New session";
}
