import { CrpmScheduler } from "./crpm.js";
import { availableDoctors, doctorModel, type DoctorId, type DoctorSpec } from "./doctors.js";
import { NvidiaProvider } from "./nvidia.js";
import { unfence } from "./tooltext.js";
import type { ContentPart, Message, Provider } from "./types.js";

/**
 * The repair chain.
 *
 * When the manager finds the work incomplete, the obvious move is to hand it
 * back to the model that just produced it. That is what happens when no doctor
 * team is configured, and it is the weakest available answer: the worker failed
 * at this once already, with the same context and the same ceiling.
 *
 * The doctors are the stronger path. Each holds its own credential, so the
 * chain runs without touching the worker's or the manager's rate budget, and
 * each has one job narrow enough to do well:
 *
 *   d1 reads the finding and the file and says what is actually wrong.
 *   d2 writes the corrected file — the whole file, not a patch.
 *   d3 checks the correction against the original finding.
 *   d4 looks at what else might have broken.
 *   d5 looks at the rendering, when there is one.
 *   d6 writes the line that goes in the record.
 *
 * Every one of them is optional. A doctor with no credential or no model simply
 * is not on duty, and the chain does what it can with the rest — except d2,
 * which is the repair itself: without it there is nothing to run.
 *
 * Nothing here is allowed to make things worse. A correction that came back
 * truncated, empty, or shorter than the file it replaces is refused rather than
 * written, because a page replaced by a fragment of itself is a worse outcome
 * than the fault that started this.
 */

export interface RepairInput {
  /** What the user asked for. */
  request: string;
  /** The manager's finding — the reason the work came back. */
  finding: string;
  issues: string[];
  runtimeErrors?: string[];
  files: Array<{ path: string; content: string }>;
  /** A PNG data URL of the rendered result, when one was captured. */
  screenshot?: string;
}

export interface RepairStep {
  id: DoctorId;
  /** The line the user may see. Never names a model or a vendor. */
  label: string;
  ok: boolean;
  detail?: string;
  /** What this doctor produced, for the row the user can open. */
  body?: string;
}

export interface RepairResult {
  /** False when no team is configured — the caller falls back to the worker. */
  ran: boolean;
  status: "repaired" | "unchanged" | "failed";
  files: Array<{ path: string; content: string }>;
  /** One line for the transcript, in Nomin's voice. */
  summary: string;
  steps: RepairStep[];
}

/**
 * How a doctor's provider is built. Supplying one lets the chain be driven by
 * scripted stubs, which is the only way to test six specialists talking to each
 * other without six credentials and a real bill.
 */
export type ProviderFor = (spec: DoctorSpec, env: NodeJS.ProcessEnv) => Provider;

const liveProvider: ProviderFor = (spec, env) =>
  new NvidiaProvider(doctorModel(spec, env), env[spec.apiKeyEnv] ?? "");

/** How many files one repair will rewrite. Bounded to keep a repair a repair. */
const MAX_TARGETS = 2;

/** A correction shorter than this share of the original is not a correction. */
const MIN_KEPT = 0.6;

const scheduler = new CrpmScheduler();

/**
 * Run the chain. Yields progress as it goes — a repair takes long enough that
 * silence would be indistinguishable from a hang — and returns the result.
 */
export async function* repair(
  input: RepairInput,
  env = process.env,
  makeProvider: ProviderFor = liveProvider,
): AsyncGenerator<RepairStep, RepairResult> {
  const team = new Map(availableDoctors(env).map((doctor) => [doctor.id, doctor]));
  const surgeon = team.get("d2");
  if (!surgeon) {
    return {
      ran: false,
      status: "unchanged",
      files: [],
      summary: "No repair team is configured.",
      steps: [],
    };
  }

  const steps: RepairStep[] = [];
  const record = (step: RepairStep) => {
    steps.push(step);
    return step;
  };

  const targets = chooseTargets(input);
  if (!targets.length) {
    return {
      ran: false,
      status: "unchanged",
      files: [],
      summary: "There was no file to repair.",
      steps: [],
    };
  }

  const brief = describeFinding(input);

  // --- d1: what is actually wrong ----------------------------------------
  let diagnosis = "";
  const doctor1 = team.get("d1");
  if (doctor1) {
    const said = await ask(
      doctor1,
      DIAGNOSE_PROMPT,
      `${brief}\n\n${targets.map((file) => fileBlock(file)).join("\n\n")}`,
      env,
      makeProvider,
    );
    diagnosis = said.text.trim();
    yield record({
      id: "d1",
      label: doctor1.publicLabel,
      ok: Boolean(diagnosis),
      detail: diagnosis ? undefined : said.error,
      body: diagnosis || undefined,
    });
  }

  // --- d2: the repair itself ---------------------------------------------
  const repaired: Array<{ path: string; content: string }> = [];
  const refused: string[] = [];

  for (const target of targets) {
    const said = await ask(
      surgeon,
      REPAIR_PROMPT,
      [
        brief,
        diagnosis ? `What the diagnosis found:\n${diagnosis}` : "",
        fileBlock(target),
        `Return the complete corrected contents of ${target.path}, and nothing else.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      env,
      makeProvider,
    );

    const content = unfence(said.text).trim();
    const refusal = whyRefused(content, target.content, said.truncated);
    if (refusal) {
      refused.push(`${target.path}: ${refusal}`);
      continue;
    }
    repaired.push({ path: target.path, content: `${content}\n` });
  }

  yield record({
    id: "d2",
    label: surgeon.publicLabel,
    ok: repaired.length > 0,
    detail: repaired.length
      ? `${repaired.length} file${repaired.length === 1 ? "" : "s"} rewritten`
      : refused[0],
    body: repaired.map((file) => `${file.path}\n\n${file.content}`).join("\n\n") || refused.join("\n"),
  });

  if (!repaired.length) {
    return {
      ran: true,
      status: "failed",
      files: [],
      summary: refused.length
        ? `The repair was refused: ${refused[0]}`
        : "The repair produced nothing usable.",
      steps,
    };
  }

  // --- d3, d4, d5: the checks, all optional, all in parallel -------------
  const checks = await Promise.all([
    check(
      team.get("d3"),
      VERIFY_PROMPT,
      `${brief}\n\n${repaired.map(fileBlock).join("\n\n")}`,
      env,
      makeProvider,
    ),
    check(
      team.get("d4"),
      REGRESSION_PROMPT,
      `${brief}\n\nRepaired: ${repaired.map((file) => file.path).join(", ")}\n` +
        `Other files in the workspace: ${
          input.files
            .map((file) => file.path)
            .filter((path) => !repaired.some((file) => file.path === path))
            .join(", ") || "none"
        }\n\n${repaired.map(fileBlock).join("\n\n")}`,
      env,
      makeProvider,
    ),
    input.screenshot
      ? check(team.get("d5"), SURFACE_PROMPT, brief, env, makeProvider, input.screenshot)
      : Promise.resolve(null),
  ]);

  for (const [index, id] of (["d3", "d4", "d5"] as const).entries()) {
    const result = checks[index];
    const doctor = team.get(id);
    if (!result || !doctor) continue;
    yield record({
      id,
      label: doctor.publicLabel,
      ok: result.ok,
      detail: result.ok ? undefined : "found something",
      body: result.text || undefined,
    });
  }

  const held = checks[0]?.ok ?? true;
  const concerns = checks
    .slice(1)
    .flatMap((result) => (result && !result.ok && result.text ? [result.text] : []));

  // --- d6: the line that goes in the record ------------------------------
  let line = "";
  const scribe = team.get("d6");
  if (scribe) {
    const said = await ask(
      scribe,
      RECORD_PROMPT,
      `${brief}\n\nFiles rewritten: ${repaired.map((file) => file.path).join(", ")}\n` +
        (diagnosis ? `Diagnosis: ${diagnosis}` : ""),
      env,
      makeProvider,
    );
    line = said.text.trim().split("\n")[0]?.slice(0, 160) ?? "";
    yield record({ id: "d6", label: scribe.publicLabel, ok: Boolean(line), body: line || undefined });
  }

  const names = repaired.map((file) => file.path).join(", ");
  const summary =
    line ||
    (held
      ? `Repaired ${names}.`
      : `Rewrote ${names}, but the check did not confirm it holds.`);

  return {
    ran: true,
    status: held ? "repaired" : "unchanged",
    files: repaired,
    summary: concerns.length ? `${summary} ${concerns[0]}` : summary,
    steps,
  };
}

/**
 * Which files this repair touches.
 *
 * A finding usually names its file. When it does not, the page the canvas runs
 * is the deliverable and therefore the thing that was judged.
 */
function chooseTargets(input: RepairInput): Array<{ path: string; content: string }> {
  const said = [input.finding, ...input.issues, ...(input.runtimeErrors ?? [])].join(" ").toLowerCase();
  const named = input.files.filter((file) => said.includes(file.path.toLowerCase()));
  if (named.length) return named.slice(0, MAX_TARGETS);

  const pages = input.files.filter((file) => /\.html?$/i.test(file.path));
  const pool = pages.length ? pages : input.files;
  // The largest is the deliverable; the rest are usually assets beside it.
  return [...pool].sort((a, b) => b.content.length - a.content.length).slice(0, 1);
}

/** Why a correction was not written. Empty string means it was accepted. */
function whyRefused(content: string, original: string, truncated: boolean): string {
  if (!content) return "it came back empty";
  if (truncated) return "it was cut off at the token limit";
  if (content.length < original.length * MIN_KEPT) {
    return `it is ${content.length} bytes against ${original.length} — a fragment, not a correction`;
  }
  if (content === original.trim()) return "nothing was changed";
  return "";
}

const fileBlock = (file: { path: string; content: string }) =>
  `--- ${file.path} ---\n${file.content.slice(0, 40_000)}`;

function describeFinding(input: RepairInput): string {
  return [
    `THE REQUEST: ${input.request.slice(0, 400)}`,
    `WHAT THE REVIEW FOUND: ${input.finding}`,
    input.issues.length ? `Findings:\n${input.issues.map((issue) => `- ${issue}`).join("\n")}` : "",
    input.runtimeErrors?.length
      ? `It throws at runtime:\n${input.runtimeErrors.map((error) => `- ${error}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** One optional doctor's opinion. A doctor that is off duty returns null. */
async function check(
  doctor: DoctorSpec | undefined,
  system: string,
  user: string,
  env: NodeJS.ProcessEnv,
  makeProvider: ProviderFor,
  screenshot?: string,
): Promise<{ ok: boolean; text: string } | null> {
  if (!doctor) return null;
  const said = await ask(doctor, system, user, env, makeProvider, screenshot);
  const text = said.text.trim();
  if (!text) return { ok: true, text: "" };
  // Every check answers on its first line, so a long opinion never has to be
  // parsed to find the verdict in it.
  const verdict = text.split("\n")[0]?.trim().toUpperCase() ?? "";
  return { ok: verdict.startsWith("OK"), text };
}

/** One call, on this doctor's own lane, never throwing. */
async function ask(
  doctor: DoctorSpec,
  system: string,
  user: string | ContentPart[],
  env: NodeJS.ProcessEnv,
  makeProvider: ProviderFor,
  screenshot?: string,
): Promise<{ text: string; truncated: boolean; error?: string }> {
  const content: string | ContentPart[] = screenshot
    ? [
        { type: "text", text: typeof user === "string" ? user : "" },
        { type: "image_url", image_url: { url: screenshot } },
      ]
    : user;

  const messages: Message[] = [
    { role: "system", content: system },
    { role: "user", content },
  ];

  // A lane is a credential, so two doctors sharing a key are serialised and six
  // on their own keys genuinely run at once.
  return scheduler.run(
    doctor.apiKeyEnv,
    async () => {
      let text = "";
      let truncated = false;
      let error: string | undefined;
      try {
        const provider = makeProvider(doctor, env);
        for await (const event of provider.stream({
          messages,
          maxTokens: doctor.maxOutputTokens,
          temperature: doctor.temperature,
        })) {
          if (event.type === "delta") text += event.text;
          if (event.type === "error") error = event.message;
          if (event.type === "done") truncated = event.finishReason === "length";
        }
      } catch (problem) {
        error = problem instanceof Error ? problem.message : "The specialist could not be reached.";
      }
      return { text, truncated, error };
    },
    "background",
  );
}

const BRIEF = `You are one specialist on Nomin's repair team. You are given a finding from a review and the work it concerns. Answer only within your role. Never mention models, vendors, or that you are an AI.`;

const DIAGNOSE_PROMPT = `${BRIEF}

Your role is diagnosis. Say what is actually wrong with the work, where in the file it is, and why it produces the finding. Be specific and concrete — name the elements, the rules, the lines. Do not write the fix. Six short lines at most.`;

const REPAIR_PROMPT = `${BRIEF}

Your role is the repair. Return the complete corrected contents of the file and nothing else: no explanation, no commentary, no code fence, no preamble. Keep everything that was already right — you are correcting a file, not rewriting it from scratch, and anything you leave out is lost. Address the finding fully.`;

const VERIFY_PROMPT = `${BRIEF}

Your role is verification. Decide whether the repaired file actually resolves the finding. Answer with OK on the first line if it does, or PROBLEM on the first line if it does not, then at most three short lines saying why.`;

const REGRESSION_PROMPT = `${BRIEF}

Your role is looking for knock-on damage. Decide whether the repair is likely to have broken something that was working — a removed element another file depends on, a renamed selector, a changed interface. Answer with OK on the first line if nothing is at risk, or PROBLEM on the first line if something is, then at most three short lines naming it.`;

const SURFACE_PROMPT = `${BRIEF}

Your role is the surface: you are shown a rendering of the result before the repair. Say what is really there — complete and presentable, or a skeleton with placeholder text, unstyled elements, collapsed layout, missing sections or unreadable content. Answer with OK on the first line if it looks finished, or PROBLEM on the first line if it does not, then at most three short lines.`;

const RECORD_PROMPT = `${BRIEF}

Your role is the record. Write one plain sentence, under 140 characters, saying what was changed and what it fixes. Address the user directly and never mention the team, the review or the failure. Output the sentence alone.`;
