import { parseLooseJson } from "./tooltext.js";

/**
 * The plan — and the gate in front of it.
 *
 * Substantial work does not begin on a guess. Trion writes a plan, the user
 * approves or changes it, and only then does the agent get tools. That
 * sequence is enforced in code rather than asked for politely in a prompt:
 * without an approved plan the tool list is simply not sent, so the model
 * cannot touch the workspace even if it decides to.
 */

export interface PlanStep {
  title: string;
  detail?: string;
}

export interface Plan {
  /** What the agent believes was asked for, in its own words. */
  understanding: string;
  objective: string;
  steps: PlanStep[];
  files: string[];
  assumptions: string[];
  risks: string[];
  testing: string;
  verification: string;
  output: string;
}

export type PlanStatus = "none" | "proposed" | "approved" | "changes-requested";

const BLOCK = /```nomin-plan\s*\n([\s\S]*?)```/;

/** True while a plan block is still streaming in. */
export const planIncoming = (answer: string) =>
  answer.includes("```nomin-plan") && !BLOCK.test(answer);

/** Lift a plan out of an answer. Returns the prose without it, and the plan. */
export function parsePlan(answer: string): { text: string; plan: Plan | null } {
  const match = BLOCK.exec(answer);
  if (!match?.[1]) return { text: answer, plan: null };

  const text = answer.replace(BLOCK, "").trimEnd();
  // Tolerant on purpose: a plan is lost otherwise for a single stray brace,
  // and what the user then sees is raw JSON where the plan should have been.
  const raw = parseLooseJson(match[1]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { text, plan: null };
  return { text, plan: normalise(raw as Record<string, unknown>) };
}

function normalise(raw: Record<string, unknown>): Plan | null {
  const objective = str(raw.objective);
  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .map((step) => {
          if (typeof step === "string") return { title: step.trim() };
          if (step && typeof step === "object") {
            const record = step as Record<string, unknown>;
            const title = str(record.title) || str(record.step);
            return title ? { title, detail: str(record.detail) || undefined } : null;
          }
          return null;
        })
        .filter((step): step is PlanStep => step !== null)
        .slice(0, 20)
    : [];

  if (!objective || !steps.length) return null;

  return {
    understanding: str(raw.understanding),
    objective,
    steps,
    files: list(raw.files),
    assumptions: list(raw.assumptions),
    risks: list(raw.risks),
    testing: str(raw.testing),
    verification: str(raw.verification),
    output: str(raw.output),
  };
}

const str = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 600) : "");
const list = (value: unknown) =>
  Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 12) : [];

/**
 * The approved plan, handed back to the agent as context for every execution
 * turn, so the work stays anchored to what the user actually agreed to.
 */
export function planBrief(plan: Plan): string {
  // A plan reaches this function over HTTP as well as from `parsePlan`, so the
  // shape is not guaranteed even though the type says so. Reading a missing
  // array threw, and the turn died before its first round — with the tools
  // already unlocked, because the plan's presence is what unlocks them.
  const steps = (plan.steps ?? []).map((step, i) => `${i + 1}. ${step.title}`).join("\n");
  const files = plan.files ?? [];
  return [
    `APPROVED PLAN — build exactly this, in order.`,
    `Objective: ${plan.objective}`,
    steps ? `Steps:\n${steps}` : "",
    files.length ? `Files: ${files.join(", ")}` : "",
    `Testing: ${plan.testing || "run what you build"}`,
    `Verification: ${plan.verification || "confirm it runs before claiming success"}`,
    `Use the tools to write real files and run real commands. Do not paste whole files into the reply; write them to the workspace.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
