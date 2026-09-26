/**
 * Checkpoints: a way back from a turn that made things worse.
 *
 * An agent that edits files is useful exactly because it does not ask before
 * each one — and that is also what makes it frightening. A checkpoint is the
 * cheap answer: before a build runs, the workspace as it stands is copied
 * aside. Restoring costs nothing, calls nothing, and works offline, because
 * the whole record already lives in the browser beside the session.
 *
 * They are deliberately not git. There is no branching, no merge and no
 * history beyond a handful of recent states — just "put it back the way it
 * was before that turn", which is the thing people actually want when a build
 * goes wrong.
 */

import type { WorkspaceSnapshot } from "./workspace.js";
import { emptySnapshot, mergeFiles } from "./workspace.js";

export interface CheckpointFile {
  path: string;
  bytes: number;
  content?: string;
}

export interface Checkpoint {
  id: string;
  /** When it was taken. */
  at: number;
  /** What the turn was about, so the list reads as history rather than hashes. */
  label: string;
  files: CheckpointFile[];
}

/**
 * How many to keep. Each one holds a full copy of the workspace, so this is a
 * storage budget as much as a usability one: ten is far more than anybody
 * scrolls back through, and still small enough to sit in IndexedDB.
 */
export const MAX_CHECKPOINTS = 10;

/** An empty workspace is not worth a checkpoint — there is nothing to lose. */
export function worthCheckpointing(snapshot: WorkspaceSnapshot): boolean {
  return snapshot.files.some((file) => file.content !== undefined);
}

/**
 * Take one, and drop the oldest if the list is full.
 *
 * Identical consecutive states are skipped: two turns that changed nothing
 * would otherwise push the useful checkpoints off the end of the list.
 */
export function capture(
  existing: Checkpoint[],
  snapshot: WorkspaceSnapshot,
  label: string,
): Checkpoint[] {
  if (!worthCheckpointing(snapshot)) return existing;

  const files = snapshot.files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    content: file.content,
  }));

  const newest = existing[0];
  if (newest && signature(newest.files) === signature(files)) return existing;

  const checkpoint: Checkpoint = {
    id: `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    label: label.trim().slice(0, 80) || "Before a build",
    files,
  };

  return [checkpoint, ...existing].slice(0, MAX_CHECKPOINTS);
}

/**
 * Rebuild the workspace as it was.
 *
 * Files added after the checkpoint are not carried over — restoring means the
 * workspace as it stood, not a merge, or "undo" would leave behind exactly the
 * files the user was trying to get rid of.
 */
export function restore(checkpoint: Checkpoint): WorkspaceSnapshot {
  return mergeFiles(emptySnapshot, checkpoint.files);
}

/** A stable fingerprint of a file set, for spotting a turn that changed nothing. */
function signature(files: CheckpointFile[]): string {
  return files
    .map((file) => `${file.path}:${file.bytes}:${hash(file.content ?? "")}`)
    .sort()
    .join("|");
}

function hash(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    value = (value * 31 + text.charCodeAt(i)) | 0;
  }
  return value;
}

/** "4 files · 2 minutes ago" — what the restore list shows under each entry. */
export function describe(checkpoint: Checkpoint, now = Date.now()): string {
  const count = checkpoint.files.length;
  const files = `${count} file${count === 1 ? "" : "s"}`;
  const seconds = Math.max(0, Math.round((now - checkpoint.at) / 1000));
  if (seconds < 60) return `${files} · just now`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${files} · ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${files} · ${hours} h ago`;
}
