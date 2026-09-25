import { NvidiaProvider } from "./nvidia.js";
import { SUPERVISOR, type ModelDescriptor } from "./registry.js";
import type { ContentPart, Message } from "./types.js";

/**
 * The monitor — Nomin Code's manager AI.
 *
 * Its job is to answer one question honestly: *was the work actually
 * delivered?* It never writes code and never touches the workspace; it only
 * judges what the worker model produced.
 *
 * Three deliberate architectural choices:
 *
 * 1. **Evidence before opinion.** Most failures are detectable without a model
 *    at all — an empty answer, a failing test with no fix after it, a claim of
 *    "done" with no build or test event behind it. Those checks are free, run
 *    on every turn, and can settle a verdict on their own.
 *
 * 2. **It looks at the result.** When the work is previewable, the monitor is
 *    given a rendering of it. Reading code tells you whether a page exists;
 *    only looking tells you whether it is finished or a skeleton.
 *
 * 3. **Off the hot path, on its own key.** The model pass runs after the user
 *    already has their answer, on a compact digest rather than the transcript,
 *    under its own credentials and its own retry policy — so review traffic
 *    never competes with the worker's rate limit.
 *
 * With no monitor key configured it still runs, in evidence-only mode, and it
 * never upgrades a verdict to "verified" on the worker's own say-so.
 */

export type VerificationStatus = "verified" | "concerns" | "failed" | "unverified";

export interface Verdict {
  status: VerificationStatus;
  /** One user-facing line. Safe to show in the work tree. */
  summary: string;
  issues: string[];
  /** What was actually checked, so the verdict can be audited. */
  evidence: string[];
  usedModel: boolean;
  /** True when the monitor looked at a rendering, not only at the code. */
  sawRendering?: boolean;
  /** The written report, in markdown. Present when the model pass ran. */
  report?: string;
}

/** The compact record a turn leaves behind. Kept small on purpose. */
export interface TurnDigest {
  request: string;
  answer: string;
  events: Array<{ type: string; label?: string; detail?: string }>;
  durationMs: number;
  rateLimited: boolean;
  /** True when the worker finished without producing any answer text. */
  empty: boolean;
  /** Files the turn produced, for judging completeness. */
  files?: Array<{ name: string; lines: number }>;
  /** A PNG data URL of the rendered result, when one could be captured. */
  screenshot?: string;
  /** What happened when the page was actually executed. */
  runtime?: { ran: boolean; errors: string[]; nodes: number };
}

export interface SupervisorConfig {
  model: ModelDescriptor;
  apiKey: string;
  /** No events for this long while running counts as stalled. */
  stallMs: number;
}

/** Phrases that assert success — they must be backed by real events. */
const CLAIMS = [
  "all tests pass",
  "tests pass",
  "build succeeds",
  "build passed",
  "verified",
  "it works",
  "working correctly",
  "successfully built",
  "done and tested",
];

const PASS_EVENTS = new Set([
  "test.passed",
  "build.completed",
  "verification.passed",
  "command.completed",
]);

const FAIL_EVENTS = new Set([
  "test.failed",
  "build.failed",
  "step.failed",
  "tool.failed",
  "command.failed",
  "verification.failed",
]);

const EVENT_PHASE: Record<string, string> = {
  "test.passed": "test", "test.failed": "test",
  "build.completed": "build", "build.failed": "build",
  "step.completed": "step", "step.failed": "step",
  "tool.started": "tool", "tool.failed": "tool",
  "command.completed": "command", "command.started": "command", "command.failed": "command",
  "verification.passed": "verify", "verification.failed": "verify",
};

const WORK_EVENTS = new Set([
  "file.created",
  "file.modified",
  "command.started",
  "build.started",
  "test.started",
  "tool.started",
  "artifact.created",
]);

export function createSupervisor(env = process.env): Supervisor {
  const key = env[SUPERVISOR.apiKeyEnv ?? "NOMIN_SUPERVISOR_API_KEY"] ?? "";
  const model: ModelDescriptor = {
    ...SUPERVISOR,
    backend: env.NOMIN_SUPERVISOR_MODEL ?? SUPERVISOR.backend,
    endpoint: env.NOMIN_SUPERVISOR_URL ?? SUPERVISOR.endpoint,
  };
  return new Supervisor({ model, apiKey: key, stallMs: 45_000 });
}

export class Supervisor {
  private readonly config: SupervisorConfig;

  constructor(config: SupervisorConfig) {
    this.config = config;
  }

  /** "model" once a separate key is configured; "evidence" otherwise. */
  get mode(): "evidence" | "model" {
    return this.config.apiKey ? "model" : "evidence";
  }

  get canSee(): boolean {
    return this.mode === "model" && this.config.model.capabilities.vision;
  }

  /**
   * Whether a model review is worth an API call. Trivial conversational turns
   * are settled by evidence alone — that is what keeps this affordable.
   */
  shouldReview(digest: TurnDigest): boolean {
    if (this.mode !== "model") return false;
    const didWork = digest.events.some((event) => WORK_EVENTS.has(event.type));
    return didWork || Boolean(digest.files?.length) || claimsSuccess(digest.answer);
  }

  /** Evidence pass, then — only if needed and configured — a model review. */
  async review(digest: TurnDigest): Promise<Verdict> {
    const verdict = this.inspect(digest);
    if (verdict.status === "failed" || !this.shouldReview(digest)) return verdict;

    try {
      const judged = await this.ask(digest, verdict);
      return judged ?? verdict;
    } catch {
      // A monitor outage must never fail the user's turn.
      return { ...verdict, issues: [...verdict.issues, "Monitor unavailable"] };
    }
  }

  /** The free pass: what the event log and the answer themselves prove. */
  inspect(digest: TurnDigest): Verdict {
    const issues: string[] = [];
    const evidence: string[] = [];

    if (digest.empty || !digest.answer.trim()) {
      return {
        status: "failed",
        summary: "The turn produced no answer",
        issues: ["Worker finished without output"],
        evidence: ["answer length 0"],
        usedModel: false,
      };
    }

    // A page that throws on load is broken however good it looks.
    if (digest.runtime?.errors.length) {
      return {
        status: "concerns",
        summary: `The page throws at runtime: ${digest.runtime.errors[0]}`,
        issues: digest.runtime.errors,
        evidence: ["ran the page"],
        usedModel: false,
      };
    }

    const failures = digest.events.filter((event) => FAIL_EVENTS.has(event.type));
    const passes = digest.events.filter((event) => PASS_EVENTS.has(event.type));
    const work = digest.events.filter((event) => WORK_EVENTS.has(event.type));

    if (work.length) evidence.push(`${work.length} work steps`);
    if (passes.length) evidence.push(`${passes.length} passing checks`);
    if (digest.files?.length) evidence.push(`${digest.files.length} files`);
    if (digest.runtime?.ran) {
      evidence.push(
        digest.runtime.errors.length ? "ran with errors" : `ran clean (${digest.runtime.nodes} elements)`,
      );
    }
    if (digest.rateLimited) evidence.push("resumed after a rate limit");

    // A failure is only forgiven if something passed after it.
    for (const failure of failures) {
      const failedAt = digest.events.indexOf(failure);
      const failPhase = EVENT_PHASE[failure.type];
      const recovered = digest.events
        .slice(failedAt + 1)
        .some((event) => PASS_EVENTS.has(event.type) && EVENT_PHASE[event.type] === failPhase);
      if (!recovered) issues.push(`Unresolved failure: ${failure.label ?? failure.type}`);
    }

    if (claimsSuccess(digest.answer) && !passes.length) {
      issues.push("Claimed success with no passing build, test or verification");
    }

    if (digest.durationMs > this.config.stallMs && !work.length && !passes.length && !digest.files?.length) {
      issues.push("Long turn with no observable work");
    }

    if (issues.length) {
      return { status: "concerns", summary: issues[0]!, issues, evidence, usedModel: false };
    }

    // No evidence of verification is not the same as verified.
    const status: VerificationStatus = passes.length ? "verified" : "unverified";
    return {
      status,
      summary:
        status === "verified"
          ? `Checked against ${evidence.join(", ")}`
          : evidence.length
            ? `Produced ${evidence.join(", ")}; not yet verified`
            : "Answered; nothing to verify against",
      issues: [],
      evidence,
      usedModel: false,
    };
  }

  /**
   * The paid pass. When a rendering was captured the monitor *looks* at it —
   * the only way to tell a finished page from a skeleton that merely parses.
   */
  private async ask(digest: TurnDigest, base: Verdict): Promise<Verdict | null> {
    const provider = new NvidiaProvider(this.config.model, this.config.apiKey);
    const seeing = Boolean(digest.screenshot) && this.canSee;
    const body: string | ContentPart[] = seeing
      ? [
          { type: "text", text: renderDigest(digest) },
          { type: "image_url", image_url: { url: digest.screenshot! } },
        ]
      : renderDigest(digest);

    const messages: Message[] = [
      { role: "system", content: seeing ? VISION_PROMPT : TEXT_PROMPT },
      { role: "user", content: body },
    ];

    let raw = "";
    for await (const event of provider.stream({
      messages,
      maxTokens: this.config.model.maxOutputTokens ?? 900,
      temperature: 0,
    })) {
      if (event.type === "delta") raw += event.text;
      if (event.type === "error") return null;
    }

    const parsed = parseVerdict(raw);
    if (!parsed) return null;
    return {
      status: parsed.status,
      summary: parsed.summary || base.summary,
      issues: parsed.issues.length ? parsed.issues : base.issues,
      evidence: seeing ? [...base.evidence, "rendering reviewed"] : base.evidence,
      usedModel: true,
      sawRendering: seeing,
      report: parsed.report,
    };
  }
}

const VERDICT_SHAPE = `Reply with JSON only:
{"status":"verified|concerns|failed|unverified","summary":"one short line","issues":["..."],"report":"markdown, 4-8 short lines"}

"verified" needs real evidence. "unverified" means it looks fine but nothing proves it. "concerns" means missing requirements, unresolved failures or unsupported claims. "failed" means it was not delivered. Be strict and brief.`;

const TEXT_PROMPT = `You are Nomin's manager. You review an engineering agent's work and judge only whether it was actually delivered — you never do the work yourself. Never complain to the user; provide clear, constructive feedback so the agent can redo the work properly.

${VERDICT_SHAPE}

The report covers: what was requested, what was produced, what is missing, and what to check next.`;

const VISION_PROMPT = `You are Nomin's manager. You are shown what an engineering agent produced and a rendering of the result. Judge whether the delivered work actually matches the request. Never complain to the user; provide clear, constructive feedback so the agent can redo the work properly.

Look at the rendering and say what is really there: complete and presentable, or a skeleton — placeholder text, unstyled elements, collapsed layout, missing sections, overlapping or unreadable content. The RUNTIME line says what happened when the page was actually executed; a page that threw is not verified no matter how it looks.

${VERDICT_SHAPE}

The report covers: what was requested, what the rendering actually shows, what is missing or broken, and what to fix next. Judge the rendering, not the intention.`;

/** The digest the monitor sees: capped, structured, no private reasoning. */
function renderDigest(digest: TurnDigest): string {
  const files = digest.files?.length
    ? digest.files.map((file) => `${file.name} (${file.lines} lines)`).join(", ")
    : "none";
  const events = digest.events
    .slice(-24)
    .map(
      (event) =>
        `${event.type}${event.label ? ` ${event.label}` : ""}${event.detail ? ` (${event.detail})` : ""}`,
    )
    .join("\n");
  const runtime = digest.runtime?.ran
    ? digest.runtime.errors.length
      ? `threw: ${digest.runtime.errors.join("; ").slice(0, 300)}`
      : `ran with no errors, ${digest.runtime.nodes} elements rendered`
    : "not executed";

  return [
    `REQUEST: ${digest.request.slice(0, 400)}`,
    `RUNTIME: ${runtime}`,
    `ANSWER (${digest.answer.length} chars): ${digest.answer.slice(0, 900)}`,
    `FILES PRODUCED: ${files}`,
    `DURATION: ${Math.round(digest.durationMs / 1000)}s${digest.rateLimited ? " (rate limited, resumed)" : ""}`,
    `EVENTS:\n${events || "none"}`,
  ].join("\n\n");
}

function parseVerdict(
  raw: string,
): { status: VerificationStatus; summary: string; issues: string[]; report?: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      status?: string;
      summary?: string;
      issues?: string[];
      report?: string;
    };
    const status = parsed.status as VerificationStatus | undefined;
    if (!status || !["verified", "concerns", "failed", "unverified"].includes(status)) return null;
    return {
      status,
      summary: (parsed.summary ?? "").slice(0, 160),
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 5).map(String) : [],
      report: typeof parsed.report === "string" ? parsed.report.slice(0, 2400) : undefined,
    };
  } catch {
    return null;
  }
}

const claimsSuccess = (answer: string) => {
  const text = answer.toLowerCase();
  return CLAIMS.some((claim) => text.includes(claim));
};
