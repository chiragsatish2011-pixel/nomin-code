import { EVENT_RULES, type AgentEvent, type NodeKind, type NodeState } from "./events.js";

export interface TreeNode {
  id: string;
  parent: string | null;
  kind: NodeKind;
  state: NodeState;
  label: string;
  detail?: string;
  /** Evidence shown when the row is opened — thinking, code, or output. */
  body?: string;
  bodyKind?: "thinking" | "code" | "output" | "text";
  bodyTitle?: string;
  /** Countdown target (epoch ms) for cooldown nodes. */
  waitUntil?: number;
  startedAt: number;
  endedAt?: number;
  children: string[];
  /** True until the renderer has drawn it once — drives the entrance animation. */
  fresh: boolean;
}

export interface TreeState {
  rootId: string | null;
  nodes: Map<string, TreeNode>;
  /** Innermost open node first. */
  openStack: string[];
  /** Set while a rate limit / cooldown is in effect. */
  waiting: boolean;
}

export function createTreeState(): TreeState {
  return { rootId: null, nodes: new Map(), openStack: [], waiting: false };
}

let autoId = 0;
const nextId = (kind: string) => `${kind}-${++autoId}`;

/**
 * Fold one event into the tree. Returns true when the shape or state changed,
 * so the renderer only re-lays-out when it has to.
 */
export function applyEvent(state: TreeState, event: AgentEvent): boolean {
  const rule = EVENT_RULES[event.type];
  if (!rule) return false;
  const at = event.at ?? Date.now();

  if (rule.op === "resume") {
    state.waiting = false;
    for (const node of state.nodes.values()) {
      if (node.state !== "waiting" || node.kind === "plan") continue;
      // An open node picks its work back up; a settled marker just closes.
      node.state = state.openStack.includes(node.id) ? "active" : "done";
      if (node.state === "done") node.endedAt = at;
      node.waitUntil = undefined;
    }
    return true;
  }

  if (rule.op === "close") {
    const id = event.id ?? findOpen(state, event);
    if (!id) return false;
    const node = state.nodes.get(id);
    if (!node) return false;
    node.state = rule.state;
    node.endedAt = at;
    node.waitUntil = undefined;
    if (event.label) node.label = event.label;
    if (event.detail !== undefined) node.detail = event.detail;
    // The evidence usually arrives with the closing event, because that is
    // when the thinking is finished and the file is actually written.
    if (event.body) {
      node.body = event.body;
      node.bodyKind = event.bodyKind ?? node.bodyKind;
      node.bodyTitle = event.bodyTitle ?? node.bodyTitle;
    }
    // Settle anything still open beneath it — a closed parent ends its children.
    const cut = state.openStack.indexOf(id);
    if (cut !== -1) {
      for (const orphan of state.openStack.slice(0, cut)) {
        const child = state.nodes.get(orphan);
        if (child && child.state === "active") {
          child.state = rule.state === "failed" ? "failed" : "done";
          child.endedAt = at;
        }
      }
      state.openStack = state.openStack.slice(cut + 1);
    }
    if (state.waiting && node.kind === "cooldown") state.waiting = false;
    return true;
  }

  const id = event.id ?? nextId(rule.kind);
  if (state.nodes.has(id)) return false;

  const parent = resolveParent(state, event);
  const node: TreeNode = {
    id,
    parent,
    kind: rule.kind,
    state: rule.op === "open" ? "active" : rule.state,
    label: event.label ?? rule.label,
    detail: event.detail,
    body: event.body,
    bodyKind: event.bodyKind,
    bodyTitle: event.bodyTitle,
    startedAt: at,
    children: [],
    fresh: true,
  };
  if (rule.op === "leaf") node.endedAt = at;

  if (rule.kind === "plan" && node.state === "done") {
    // Approval settles the "waiting for approval" marker above it.
    for (const other of state.nodes.values()) {
      if (other.kind === "plan" && other.state === "waiting") {
        other.state = "done";
        other.endedAt = at;
      }
    }
  }

  if (rule.kind === "cooldown") {
    state.waiting = true;
    if (event.waitSeconds != null) node.waitUntil = at + event.waitSeconds * 1000;
  }

  state.nodes.set(id, node);
  if (parent) state.nodes.get(parent)?.children.push(id);
  else state.rootId ??= id;

  if (rule.op === "open") state.openStack.unshift(id);
  return true;
}

/** Deepest open node of the same kind, else the deepest open node. */
function findOpen(state: TreeState, event: AgentEvent): string | undefined {
  const kind = EVENT_RULES[event.type];
  const wanted = kind && "kind" in kind ? kind.kind : undefined;
  const sameKind = state.openStack.find((id) => state.nodes.get(id)?.kind === wanted);
  return sameKind ?? state.openStack[0];
}

function resolveParent(state: TreeState, event: AgentEvent): string | null {
  if (event.parent) return state.nodes.has(event.parent) ? event.parent : null;
  return state.openStack[0] ?? state.rootId ?? null;
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
  /** Index among its siblings — the last child terminates its parent's spine. */
  lastChild: boolean;
}

/** Depth-first walk: the exact order the rows are painted top to bottom. */
export function flatten(state: TreeState): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (id: string, depth: number, lastChild: boolean) => {
    const node = state.nodes.get(id);
    if (!node) return;
    rows.push({ node, depth, lastChild });
    node.children.forEach((child, i) =>
      walk(child, depth + 1, i === node.children.length - 1),
    );
  };
  if (state.rootId) walk(state.rootId, 0, true);
  return rows;
}

/** One-line status for the header — what the agent is doing right now. */
export function currentStatus(state: TreeState): { label: string; state: NodeState } {
  const openId = state.openStack.find((id) => state.nodes.get(id)?.state !== "done");
  const node = openId ? state.nodes.get(openId) : undefined;
  if (!node) {
    const root = state.rootId ? state.nodes.get(state.rootId) : undefined;
    if (root?.state === "done") return { label: "Completed", state: "done" };
    if (root?.state === "failed") return { label: "Failed", state: "failed" };
    return { label: "Idle", state: "pending" };
  }
  if (state.waiting) return { label: node.label, state: "waiting" };
  return { label: node.label, state: node.state };
}
