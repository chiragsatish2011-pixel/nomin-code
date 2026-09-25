import type { TreeFrame } from "../model/agent.js";

/**
 * The work tree, drawn in a terminal.
 *
 * Same events as the browser, same shape — a head with branches hanging off
 * it — because the point of the tree is that you can see what the agent is
 * doing, and that should not depend on having a browser open.
 *
 * The tree is redrawn in place rather than appended, so a long build does not
 * scroll a thousand lines past. When the output is not a TTY it falls back to
 * plain appended lines, which is what a log file or a CI job actually wants.
 */

export interface TreeNode {
  id: string;
  parent: string | null;
  label: string;
  detail?: string;
  state: "active" | "done" | "failed" | "waiting";
  children: string[];
}

const DONE = new Set([
  "thinking.completed",
  "step.completed",
  "tool.completed",
  "command.completed",
  "build.completed",
  "test.passed",
  "verification.passed",
  "cooldown.completed",
  "task.completed",
  "question.answered",
]);

const FAILED = new Set([
  "step.failed",
  "tool.failed",
  "command.failed",
  "build.failed",
  "test.failed",
  "verification.failed",
]);

const LEAF = new Set(["file.created", "file.modified", "artifact.created", "rate_limit.detected", "agent.resumed"]);

export class TerminalTree {
  private readonly nodes = new Map<string, TreeNode>();
  private order: string[] = [];
  private rootId: string | null = null;
  private counter = 0;

  apply(event: TreeFrame): void {
    const id = event.id ?? `n${++this.counter}`;

    if (DONE.has(event.type) || FAILED.has(event.type)) {
      const node = this.nodes.get(id) ?? this.findOpen(event);
      if (node) {
        node.state = FAILED.has(event.type) ? "failed" : "done";
        if (event.label) node.label = event.label;
        if (event.detail) node.detail = event.detail;
        return;
      }
    }

    if (this.nodes.has(id)) {
      const node = this.nodes.get(id)!;
      if (event.label) node.label = event.label;
      if (event.detail) node.detail = event.detail;
      return;
    }

    const parent = event.parent && this.nodes.has(event.parent) ? event.parent : this.rootId;
    const node: TreeNode = {
      id,
      parent: parent ?? null,
      label: event.label ?? event.type,
      detail: event.detail,
      state: LEAF.has(event.type) ? "done" : event.type === "cooldown.started" ? "waiting" : "active",
      children: [],
    };

    this.nodes.set(id, node);
    this.order.push(id);
    if (parent) this.nodes.get(parent)?.children.push(id);
    else this.rootId ??= id;
  }

  /** The deepest still-running node, for closing an unnamed end event. */
  private findOpen(event: TreeFrame): TreeNode | undefined {
    void event;
    for (let i = this.order.length - 1; i >= 0; i--) {
      const node = this.nodes.get(this.order[i]!);
      if (node?.state === "active") return node;
    }
    return undefined;
  }

  /** Render the whole tree as lines. */
  render(colour: boolean): string[] {
    if (!this.rootId) return [];
    const lines: string[] = [];

    const walk = (id: string, prefix: string, last: boolean, depth: number) => {
      const node = this.nodes.get(id);
      if (!node) return;

      const mark = symbol(node.state);
      const branch = depth === 0 ? "" : last ? "└─ " : "├─ ";
      const detail = node.detail ? dim(` ${node.detail}`, colour) : "";
      lines.push(`${prefix}${branch}${paint(mark, node.state, colour)} ${node.label}${detail}`);

      const nextPrefix = depth === 0 ? "" : prefix + (last ? "   " : "│  ");
      node.children.forEach((child, index) =>
        walk(child, nextPrefix, index === node.children.length - 1, depth + 1),
      );
    };

    walk(this.rootId, "", true, 0);
    return lines;
  }

  get height(): number {
    return this.nodes.size;
  }
}

const symbol = (state: TreeNode["state"]) =>
  state === "done" ? "●" : state === "failed" ? "✕" : state === "waiting" ? "◐" : "◆";

const COLOURS: Record<TreeNode["state"], string> = {
  active: "\u001b[35m",
  done: "\u001b[32m",
  failed: "\u001b[31m",
  waiting: "\u001b[33m",
};

const paint = (text: string, state: TreeNode["state"], colour: boolean) =>
  colour ? `${COLOURS[state]}${text}\u001b[0m` : text;

const dim = (text: string, colour: boolean) => (colour ? `\u001b[2m${text}\u001b[0m` : text);
