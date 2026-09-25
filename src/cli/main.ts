import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { runTurn } from "../model/agent.js";
import { parsePlan, type Plan } from "../model/plan.js";
import { parseQuestions, formatAnswers } from "../lib/questions.js";
import { getModel, listModels } from "../model/registry.js";
import { availableDoctors } from "../model/doctors.js";
import { Workspace } from "../model/workspace.js";
import { TerminalTree } from "./tree.js";

/**
 * Nomin Code in a terminal.
 *
 * The same agent, the same plan gate, the same work tree — without a browser.
 * That matters for the cases a GUI is bad at: running a build over ssh, piping
 * a task into a script, or watching what the agent does while you work in the
 * next window.
 *
 * Two modes fall out of one implementation. Attached to a terminal it redraws
 * the tree in place and asks before it builds. Piped, it prints plain lines
 * and refuses to block on a prompt nobody can answer — `--yes` is how you say
 * "approve the plan and go" up front.
 */

interface Options {
  task: string;
  mode: "quick" | "balanced" | "deep";
  autoApprove: boolean;
  out: string | null;
  json: boolean;
  session: string;
}

const HELP = `nomin — an autonomous engineering workspace in your terminal

  nomin "build a landing page for a coffee shop"
  nomin --deep --yes "add a dark mode toggle"
  nomin --out ./build "write a tip calculator page"

Options
  --quick | --deep     how much room the model gets (default: balanced)
  --yes, -y            approve the plan without asking
  --out <dir>          write the finished workspace here
  --json               emit raw events, one JSON object per line
  --session <id>       continue a named session
  --status             show what this install can do, and exit
  --help, -h           this

Nothing is built until a plan is approved.`;

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options === "help") {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  if (options === "status") {
    return status();
  }
  if (!options.task) {
    stdout.write(`${HELP}\n`);
    return 1;
  }

  if (!process.env.NVIDIA_API_KEY) {
    stdout.write(
      "No credential found. Set NVIDIA_API_KEY in your environment or .env before running a task.\n",
    );
    return 1;
  }

  const interactive = Boolean(stdout.isTTY) && !options.json;
  const view = new View(interactive, options.json);
  const history: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: options.task },
  ];

  let plan: Plan | null = null;
  let approved = false;

  // Plan, then ask, then build — the same sequence the browser enforces.
  for (let pass = 0; pass < 4; pass++) {
    const answer = await runOnce(history, plan, approved, options, view);
    if (answer.failed) return 1;

    history.push({ role: "assistant", content: answer.text });

    if (approved) {
      await save(options, view);
      return 0;
    }

    const questions = parseQuestions(answer.text).questions;
    if (questions.length) {
      if (!interactive) {
        view.note("The agent asked for requirements; rerun with more detail, or use --yes.");
        return 1;
      }
      const answers = await ask(questions);
      history.push({ role: "user", content: answers });
      continue;
    }

    const proposed = parsePlan(answer.text).plan;
    if (proposed) {
      plan = proposed;
      view.plan(proposed);
      approved = options.autoApprove || (interactive ? await confirm() : false);
      if (!approved) {
        view.note("Not approved. Nothing was built.");
        return 0;
      }
      history.push({ role: "user", content: "Plan approved. Build it exactly as agreed." });
      continue;
    }

    // No questions, no plan: the agent simply answered.
    return 0;
  }

  view.note("Gave up after four rounds without reaching a build.");
  return 1;
}

interface TurnResult {
  text: string;
  failed: boolean;
}

async function runOnce(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  plan: Plan | null,
  approved: boolean,
  options: Options,
  view: View,
): Promise<TurnResult> {
  let text = "";
  let failed = false;

  const workspace = await Workspace.open(options.session);
  const listing = await workspace.list().catch(() => []);
  const files = await Promise.all(
    listing.map(async (file) => ({
      path: file.path,
      content: await workspace.read(file.path).catch(() => ""),
    })),
  );

  for await (const frame of runTurn({
    messages: history,
    title: options.task.slice(0, 60),
    mode: options.mode,
    sessionId: options.session,
    plan: approved ? plan : null,
    files,
  })) {
    if (options.json) {
      stdout.write(`${JSON.stringify(frame)}\n`);
    }

    if (frame.kind === "tree") view.event(frame.event);
    else if (frame.kind === "text") text += frame.text;
    else if (frame.kind === "error") {
      failed = true;
      view.error(frame.message);
    } else if (frame.kind === "verdict" && !options.json) {
      view.verdict(frame.verdict.status, frame.verdict.summary);
    }
  }

  view.settle();
  if (text.trim() && !options.json) view.answer(text);
  return { text, failed };
}

/** Write the workspace out, so the result is usable outside the session. */
async function save(options: Options, view: View): Promise<void> {
  if (!options.out) return;
  const workspace = await Workspace.open(options.session);
  const files = await workspace.list().catch(() => []);
  for (const file of files) {
    const content = await workspace.read(file.path).catch(() => null);
    if (content === null) continue;
    const target = join(options.out, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  view.note(`Wrote ${files.length} file${files.length === 1 ? "" : "s"} to ${options.out}`);
}

/** Ask the clarification questions, one at a time. */
async function ask(questions: ReturnType<typeof parseQuestions>["questions"]): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answers: Record<string, string[]> = {};

  try {
    for (const [index, question] of questions.entries()) {
      stdout.write(`\n\u001b[1m${index + 1}/${questions.length} ${question.question}\u001b[0m\n`);
      question.options.forEach((option, i) => {
        stdout.write(`  ${i + 1}. ${option.label}`);
        stdout.write(option.detail ? `\u001b[2m — ${option.detail}\u001b[0m\n` : "\n");
      });
      const reply = (await rl.question("  choose a number, type your own, or press enter to skip: ")).trim();
      if (!reply) continue;
      const picked = Number(reply);
      const chosen =
        Number.isInteger(picked) && picked >= 1 && picked <= question.options.length
          ? question.options[picked - 1]!.label
          : reply;
      answers[question.id] = [chosen];
    }
  } finally {
    rl.close();
  }

  return formatAnswers(questions, answers);
}

async function confirm(): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const reply = (await rl.question("\nApprove this plan and build it? [y/N] ")).trim().toLowerCase();
    return reply === "y" || reply === "yes";
  } finally {
    rl.close();
  }
}

/** What this install can actually do — the terminal's /api/health. */
function status(): number {
  const model = getModel();
  const doctors = availableDoctors().length;
  stdout.write(`Nomin Code\n`);
  stdout.write(`  model      ${model.name}\n`);
  stdout.write(`  worker     ${process.env.NVIDIA_API_KEY ? "configured" : "missing"}\n`);
  stdout.write(`  manager    ${process.env.NOMIN_SUPERVISOR_API_KEY ? "configured" : "missing"}\n`);
  stdout.write(`  doctors    ${doctors} of 6 configured\n`);
  stdout.write(
    `  planned    ${listModels()
      .filter((entry) => entry.status === "planned")
      .map((entry) => entry.name)
      .join(", ")}\n`,
  );
  return 0;
}

/**
 * Everything that reaches the screen.
 *
 * In a terminal the tree is redrawn in place; anywhere else the same events
 * become plain lines, because a log that rewrites itself is unreadable.
 */
class View {
  private readonly tree = new TerminalTree();
  private drawn = 0;
  private readonly interactive: boolean;
  private readonly quiet: boolean;

  // Written out rather than declared as parameter properties: Node runs these
  // sources by stripping types, and that syntax has nothing to strip to.
  constructor(interactive: boolean, quiet: boolean) {
    this.interactive = interactive;
    this.quiet = quiet;
  }

  event(event: Parameters<TerminalTree["apply"]>[0]): void {
    this.tree.apply(event);
    if (this.quiet) return;
    if (this.interactive) this.redraw();
    else if (event.label) stdout.write(`  ${event.label}${event.detail ? ` (${event.detail})` : ""}\n`);
  }

  private redraw(): void {
    const lines = this.tree.render(true);
    if (this.drawn) stdout.write(`\u001b[${this.drawn}A\u001b[0J`);
    stdout.write(`${lines.join("\n")}\n`);
    this.drawn = lines.length;
  }

  /** Stop redrawing over the tree — what follows is new output. */
  settle(): void {
    this.drawn = 0;
    if (!this.quiet && this.interactive) stdout.write("\n");
  }

  plan(plan: Plan): void {
    if (this.quiet) return;
    stdout.write(`\u001b[1mPlan\u001b[0m  ${plan.objective}\n`);
    plan.steps.forEach((step, index) => stdout.write(`  ${index + 1}. ${step.title}\n`));
    if (plan.files.length) stdout.write(`\u001b[2m  files: ${plan.files.join(", ")}\u001b[0m\n`);
  }

  answer(text: string): void {
    stdout.write(`${text.trim()}\n`);
  }

  verdict(state: string, summary: string): void {
    const colour = state === "verified" ? "\u001b[32m" : state === "failed" ? "\u001b[31m" : "\u001b[33m";
    stdout.write(`\n${colour}${state}\u001b[0m  ${summary}\n`);
  }

  note(text: string): void {
    stdout.write(`${text}\n`);
  }

  error(text: string): void {
    stdout.write(`\u001b[31m${text}\u001b[0m\n`);
  }
}

function parseArgs(argv: string[]): Options | "help" | "status" {
  const words: string[] = [];
  const options: Options = {
    task: "",
    mode: "balanced",
    autoApprove: false,
    out: null,
    json: false,
    session: `cli-${Date.now().toString(36)}`,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return "help";
    else if (arg === "--status") return "status";
    else if (arg === "--quick") options.mode = "quick";
    else if (arg === "--deep") options.mode = "deep";
    else if (arg === "--yes" || arg === "-y") options.autoApprove = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--out") options.out = argv[++i] ?? null;
    else if (arg === "--session") options.session = argv[++i] ?? options.session;
    else words.push(arg);
  }

  options.task = words.join(" ").trim();
  return options;
}
