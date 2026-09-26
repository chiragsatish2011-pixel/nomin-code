/**
 * The Nomin Code agent event stream.
 *
 * Every visual in the work tree is derived from these events — nothing in the
 * renderer invents state. The agent runtime emits them; the tree reduces them.
 */

export type AgentEventType =
  | "task.started"
  | "task.completed"
  | "question.created"
  | "question.answered"
  | "plan.created"
  | "plan.approved"
  | "thinking.started"
  | "thinking.completed"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "file.created"
  | "file.modified"
  | "command.started"
  | "command.completed"
  | "command.failed"
  | "build.started"
  | "build.completed"
  | "build.failed"
  | "test.started"
  | "test.passed"
  | "test.failed"
  | "rate_limit.detected"
  | "cooldown.started"
  | "cooldown.completed"
  | "agent.resumed"
  | "verification.started"
  | "verification.passed"
  | "verification.failed"
  | "artifact.created"
  | "doctor.started"
  | "doctor.completed"
  | "doctor.failed"
  | "round.measured";

export interface AgentEvent {
  type: AgentEventType;
  /** Stable id so a `*.started` event can be closed by its matching end event. */
  id?: string;
  /** Parent node id. Defaults to the innermost open node, else the task root. */
  parent?: string;
  /** User-facing label. Falls back to a sensible default per event type. */
  label?: string;
  /** Short muted suffix — a path, a duration, an exit code, "3/12". */
  detail?: string;
  /** Seconds remaining, for cooldown/rate-limit nodes. Drives the countdown. */
  waitSeconds?: number;
  /**
   * The evidence behind the node: what it thought, the file it wrote, the
   * output a command printed. Hidden until the row is opened, because a tree
   * that shows everything at once is not a tree, it is a log.
   */
  body?: string;
  /** How the body should be shown when the row is opened. */
  bodyKind?: "thinking" | "code" | "output" | "text";
  /** The file or command the body belongs to, shown as the panel's subtitle. */
  bodyTitle?: string;
  /** Emission time in ms. Defaults to Date.now(). */
  at?: number;
}

/** Lifecycle state of a single node in the tree. */
export type NodeState =
  | "pending"
  | "active"
  | "waiting"
  | "done"
  | "failed";

/** What kind of work a node represents — drives icon/colour, not layout. */
export type NodeKind =
  | "task"
  | "question"
  | "plan"
  | "thinking"
  | "step"
  | "tool"
  | "file"
  | "command"
  | "build"
  | "test"
  | "cooldown"
  | "verify"
  | "artifact"
  | "doctor";

type Rule =
  | { op: "open"; kind: NodeKind; label: string }
  | { op: "close"; state: NodeState }
  | { op: "leaf"; kind: NodeKind; label: string; state: NodeState }
  | { op: "resume" };

/**
 * Event → tree operation. `open` pushes a node and keeps it on the open stack,
 * `close` settles the matching open node, `leaf` is an instantaneous fact.
 */
export const EVENT_RULES: Record<AgentEventType, Rule> = {
  "task.started": { op: "open", kind: "task", label: "Task" },
  "task.completed": { op: "close", state: "done" },

  "question.created": { op: "open", kind: "question", label: "Asking" },
  "question.answered": { op: "close", state: "done" },

  "plan.created": { op: "leaf", kind: "plan", label: "Plan created", state: "waiting" },
  "plan.approved": { op: "leaf", kind: "plan", label: "Plan approved", state: "done" },

  "thinking.started": { op: "open", kind: "thinking", label: "Thinking" },
  "thinking.completed": { op: "close", state: "done" },

  "step.started": { op: "open", kind: "step", label: "Step" },
  "step.completed": { op: "close", state: "done" },
  "step.failed": { op: "close", state: "failed" },

  "tool.started": { op: "open", kind: "tool", label: "Tool" },
  "tool.completed": { op: "close", state: "done" },
  "tool.failed": { op: "close", state: "failed" },

  "file.created": { op: "leaf", kind: "file", label: "Created file", state: "done" },
  "file.modified": { op: "leaf", kind: "file", label: "Edited file", state: "done" },

  "command.started": { op: "open", kind: "command", label: "Run command" },
  "command.completed": { op: "close", state: "done" },
  "command.failed": { op: "close", state: "failed" },

  "build.started": { op: "open", kind: "build", label: "Build" },
  "build.completed": { op: "close", state: "done" },
  "build.failed": { op: "close", state: "failed" },

  "test.started": { op: "open", kind: "test", label: "Test" },
  "test.passed": { op: "close", state: "done" },
  "test.failed": { op: "close", state: "failed" },

  "rate_limit.detected": { op: "leaf", kind: "cooldown", label: "Rate limit detected", state: "waiting" },
  "cooldown.started": { op: "open", kind: "cooldown", label: "Waiting for cooldown" },
  "cooldown.completed": { op: "close", state: "done" },
  "agent.resumed": { op: "resume" },

  "verification.started": { op: "open", kind: "verify", label: "Verifying" },
  "verification.passed": { op: "close", state: "done" },
  "verification.failed": { op: "close", state: "failed" },

  "artifact.created": { op: "leaf", kind: "artifact", label: "Artifact", state: "done" },

  // A second opinion is being taken. What the specialist is, and what it was
  // asked, is deliberately not said — the user is told that one is working.
  "doctor.started": { op: "open", kind: "doctor", label: "A specialist is looking" },
  "doctor.completed": { op: "close", state: "done" },
  "doctor.failed": { op: "close", state: "failed" },

  // One row per model round, carrying how it ended and what it cost. A turn
  // that quietly ran out of tokens is indistinguishable from one that chose to
  // stop unless the finish reason is written down somewhere a person can read.
  "round.measured": { op: "leaf", kind: "step", label: "Round", state: "done" },
};
