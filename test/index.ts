/**
 * Regression tests for the faults that made a finished page arrive as a stub.
 *
 * Each case here failed against the code as it was, so each one is a bug that
 * cannot come back quietly. The turn is driven by a scripted provider: no
 * credentials, no network, and the exact sequence the real run hit.
 */

import { runTurn, type TurnFrame } from "../src/model/agent.js";
import { runTool } from "../src/model/tools.js";
import { Workspace } from "../src/model/workspace.js";
import { collectArtifacts } from "../src/lib/artifacts.js";
import type { ChatMessage } from "../src/lib/useAgent.js";
import {
  endpointOf,
  getModel,
  modelConfigured,
  SUPERVISOR,
  SUPERVISOR_MODEL_ENVS,
  TRION_1_5,
} from "../src/model/registry.js";
import { createSupervisor } from "../src/model/supervisor.js";
import { availableDoctors, DOCTORS, type DoctorSpec } from "../src/model/doctors.js";
import { repair, type ProviderFor } from "../src/model/repair.js";
import { approvedPlan, call, is, main, ok, scripted, suite, test } from "./harness.js";
import type { StreamEvent } from "../src/model/types.js";

// The environment a turn runs in. Nothing here reaches a provider — every turn
// below is answered by a script — but `runTurn` still resolves the worker seat,
// and resolving it is exactly what must not depend on when this module loaded.
process.env.NVIDIA_API_KEY ??= "test-key";
process.env.NOMIN_WORKER_MODEL ??= "test/scripted";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;
const usage = (out: number): StreamEvent => ({ type: "usage", promptTokens: 10, completionTokens: out });
const done = (reason: string): StreamEvent => ({ type: "done", finishReason: reason });

/** Run one execution turn against a script and collect what it produced. */
async function execute(script: StreamEvent[][]) {
  const provider = scripted(script);
  const sessionId = `test-${Math.random().toString(36).slice(2)}`;
  const frames: TurnFrame[] = [];
  for await (const frame of runTurn({
    messages: [{ role: "user", content: "Build the page" }],
    sessionId,
    plan: approvedPlan(),
    mode: "deep",
    provider,
  })) {
    frames.push(frame);
  }
  const workspace = await Workspace.open(sessionId);
  const rows = frames.flatMap((f) => (f.kind === "tree" ? [f.event] : []));
  const text = frames.flatMap((f) => (f.kind === "text" ? [f.text] : [])).join("");
  return {
    rows,
    text,
    provider,
    read: (path: string) => workspace.read(path).catch(() => ""),
    cleanup: () => workspace.destroy(),
    /**
     * How many times the turn decided a file needed finishing. Counted from the
     * tree rather than from the prompts: history is carried forward, so one
     * instruction appears in every later request and counting messages counts
     * the same decision several times over.
     */
    nudges: () => rows.filter((row) => row.label?.startsWith("Finishing ")).length,
  };
}

// ---------------------------------------------------------------------------

suite("A file that was cut off");

test("a continuation sent as write_file appends instead of replacing", async () => {
  const head = `<!doctype html>\n<html>\n<style>\n${"a{color:red}\n".repeat(40)}`;
  const tail = `</style>\n<body>done</body>\n</html>\n`;
  const turn = await execute([
    [call("c1", "write_file", { path: "index.html", content: head }), usage(8192), done("length")],
    // Asked to append, the model reaches for write_file with only the
    // remainder — right content, wrong verb. This replaced the whole page.
    [call("c2", "write_file", { path: "index.html", content: tail }), usage(120), done("stop")],
    [{ type: "delta", text: "Finished." }, usage(20), done("stop")],
  ]);
  const file = await turn.read("index.html");
  is(file, head + tail, "the page keeps everything that was written");
  ok(file.startsWith("<!doctype html>"), "the opening survives the continuation");
  ok(
    turn.rows.some((row) => row.label?.includes("instead of replacing it")),
    "the rescue is stated rather than done quietly",
  );
  await turn.cleanup();
});

test("a genuine rewrite is left alone", async () => {
  const first = `<!doctype html>\n${"<p>long</p>\n".repeat(40)}`;
  const rewrite = `<!doctype html>\n<p>short</p>\n`;
  const turn = await execute([
    [call("c1", "write_file", { path: "index.html", content: first }), usage(8192), done("length")],
    // Shorter than what is there, but it starts the file again: a rewrite.
    [call("c2", "write_file", { path: "index.html", content: rewrite }), usage(120), done("stop")],
    [{ type: "delta", text: "Simplified." }, usage(20), done("stop")],
  ]);
  is(await turn.read("index.html"), rewrite, "a rewrite replaces, it does not append");
  await turn.cleanup();
});

test("a complete file is not declared cut off by an earlier round", async () => {
  const page = (tag: string) => `<!doctype html>\n<!-- ${tag} -->\n${"x".repeat(400)}`;
  const turn = await execute([
    [call("c1", "write_file", { path: "a.html", content: page("a") }), usage(8192), done("length")],
    // Complete, and a stream that ends without reporting a finish reason —
    // routine under load. The stale reason made this look truncated too.
    [call("c2", "write_file", { path: "b.html", content: page("b") }), usage(300)],
    [{ type: "delta", text: "Both written." }, usage(20), done("stop")],
  ]);
  is(turn.nudges(), 1, "only the round that was truncated asks to be finished");
  await turn.cleanup();
});

suite("A turn that stops mid-sentence");

test("an execution turn cut off while reporting back is continued", async () => {
  const turn = await execute([
    [call("c1", "write_file", { path: "app.js", content: "export const go = () => 1;\n" }), usage(200), done("stop")],
    [{ type: "delta", text: "Done:\n\n```js\nexport const go" }, usage(8192), done("length")],
    [{ type: "delta", text: " = () => 1;\n```\n\nIt returns 1." }, usage(60), done("stop")],
  ]);
  is((turn.text.match(/```/g) ?? []).length % 2, 0, "the code fence is closed");
  is(turn.text.split("Done:").length - 1, 1, "the first part is not printed twice");
  ok(turn.text.endsWith("It returns 1."), "the sentence is finished");
  await turn.cleanup();
});

test("every round records how it ended and what it cost", async () => {
  const turn = await execute([
    [call("c1", "write_file", { path: "a.js", content: "1\n" }), usage(4096), done("length")],
    [{ type: "delta", text: "Done." }, usage(30), done("stop")],
  ]);
  const measured = turn.rows.filter((row) => row.type === "round.measured");
  ok(measured.length >= 2, "one row per round");
  ok(measured[0]?.detail?.includes("length"), "the finish reason is on the row");
  ok(measured[0]?.detail?.includes("4096 out"), "the output tokens are on the row");
  ok(measured[0]?.body?.includes("thinking pass"), "the body says whether it deliberated");
  await turn.cleanup();
});

suite("What reaches the manager");

test("the verdict is formed from the work, not from the rounds it took", async () => {
  // One file, written once, but three rounds of conversation around it. The
  // evidence should describe the file, and should not grow with the rounds.
  const turn = await execute([
    [call("c1", "write_file", { path: "a.js", content: "1\n" }), usage(100), done("stop")],
    [call("c2", "list_files", {}), usage(30), done("stop")],
    [{ type: "delta", text: "Done." }, usage(20), done("stop")],
  ]);
  // The closing event, not "Checking the record" that opens it.
  const verdict = turn.rows.find(
    (row) => row.type === "verification.passed" || row.type === "verification.failed",
  );
  ok(verdict, "the record is checked");
  ok(
    turn.rows.filter((row) => row.type === "round.measured").length >= 3,
    "every round is still measured for the reader",
  );
  // tool.started twice and file.created once. A measurement row counted as
  // work would push this higher.
  ok(verdict?.label?.includes("3 work steps"), `the work is counted, not the rounds: ${verdict?.label}`);
  await turn.cleanup();
});

suite("The tools");

test("an append of nothing is a failure, not a silent success", async () => {
  const workspace = await Workspace.open(`tools-${Math.random().toString(36).slice(2)}`);
  await workspace.write("page.html", "<p>start</p>\n");
  for (const content of ["", "   \n", "Continuing from where it stopped:\n"]) {
    const outcome = await runTool(workspace, "append_file", JSON.stringify({ path: "page.html", content }));
    is(outcome.event.type, "tool.failed", `an append of ${JSON.stringify(content)} fails`);
  }
  is(await workspace.read("page.html"), "<p>start</p>\n", "the file is untouched by all three");
  await workspace.destroy();
});

test("a file wrapped in a code fence is unwrapped", async () => {
  const workspace = await Workspace.open(`fence-${Math.random().toString(36).slice(2)}`);
  await runTool(workspace, "write_file", JSON.stringify({ path: "a.html", content: "```html\n<p>hi</p>\n```" }));
  is(await workspace.read("a.html"), "<p>hi</p>", "the backticks do not reach the file");

  const markdown = "# Title\n\n```js\nconst a = 1;\n```\n\nmore\n\n```js\nconst b = 2;\n```\n";
  await runTool(workspace, "write_file", JSON.stringify({ path: "doc.md", content: markdown }));
  is(await workspace.read("doc.md"), markdown, "a markdown file keeps its own fences");
  await workspace.destroy();
});

suite("Configuration");

test("a credential is all a seat needs, because it carries its own model", () => {
  // The deployment case: a host holding nothing but the key still runs, which
  // is the whole reason the identifiers live in the descriptors.
  is(modelConfigured(TRION_1_5, env({ NVIDIA_API_KEY: "k" })), true, "a key is enough");
  is(modelConfigured(TRION_1_5, env({})), false, "and it is still required");
  ok(getModel("Trion 1.5", env({})).backend, "the seat resolves without any variable set");
});

test("a model variable overrides the seat it names", () => {
  is(
    getModel("Trion 1.5", env({ NOMIN_WORKER_MODEL: "vendor/other" })).backend,
    "vendor/other",
    "the variable wins where it is set",
  );
  ok(
    getModel("Trion 1.5", env({})).backend !== "vendor/other",
    "and the descriptor stands where it is not",
  );
});

test("the endpoint has a working default and honours the older variable", () => {
  ok(endpointOf(undefined, env({})).startsWith("https://"), "an unset endpoint is not the empty string");
  is(endpointOf(undefined, env({ NVIDIA_BASE_URL: "https://legacy/v1" })), "https://legacy/v1", "the older variable still works");
  is(endpointOf(undefined, env({ NOMIN_BASE_URL: "https://new/v1" })), "https://new/v1", "the newer one wins");
});

test("identifiers are read when a seat is used, not when the module loads", () => {
  is(getModel("Trion 1.5", env({ NOMIN_WORKER_MODEL: "vendor/a" })).backend, "vendor/a", "first environment");
  is(getModel("Trion 1.5", env({ NOMIN_WORKER_MODEL: "vendor/b" })).backend, "vendor/b", "and the next one");
});

test("the monitor runs on its credential alone, and falls back without one", () => {
  is(createSupervisor(env({})).mode, "evidence", "no credential, no model pass");
  is(createSupervisor(env({ NOMIN_SUPERVISOR_API_KEY: "k" })).mode, "model", "a credential is enough");
  is(
    createSupervisor(env({ NOMIN_SUPERVISOR_API_KEY: "k", NOMIN_VISION_MODEL: "m" })).mode,
    "model",
    "either model variable overrides it",
  );
  ok(SUPERVISOR_MODEL_ENVS.includes(SUPERVISOR.backendEnv ?? ""), "its own variable is one of them");
});

test("a doctor is on duty once it has a credential", () => {
  const keys = Object.fromEntries(DOCTORS.map((d) => [d.apiKeyEnv, "k"]));
  is(availableDoctors(env({})).length, 0, "nobody is on duty without keys");
  is(availableDoctors(env(keys)).length, 6, "six keys put all six on duty");
  ok(
    DOCTORS.every((doctor) => doctor.backend),
    "every seat carries the model it runs on",
  );
});

suite("The repair team");

/** Every doctor on duty, each answering with whatever the script gives it. */
const team = () => Object.fromEntries(DOCTORS.map((d) => [d.apiKeyEnv, "k"])) as NodeJS.ProcessEnv;

const speaking = (lines: Partial<Record<string, string>>): ProviderFor =>
  (spec: DoctorSpec) => ({
    id: "nvidia" as const,
    async *stream() {
      const said = lines[spec.id];
      if (said === undefined) {
        yield { type: "error", message: "off script" } as StreamEvent;
        return;
      }
      yield { type: "delta", text: said } as StreamEvent;
      yield { type: "done", finishReason: "stop" } as StreamEvent;
    },
  });

const page = (body: string) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`;
const original = page("<h1>Coffee</h1>\n" + "<p>filler</p>\n".repeat(30));
const fixed = page("<h1>Coffee</h1>\n<nav>Menu</nav>\n" + "<p>filler</p>\n".repeat(30));

async function runChain(providers: ProviderFor, env = team(), files = [{ path: "index.html", content: original }]) {
  const chain = repair(
    {
      request: "Build a landing page for a coffee shop",
      finding: "The page has no navigation",
      issues: ["No nav element"],
      files,
    },
    env,
    providers,
  );
  const seen: string[] = [];
  let step = await chain.next();
  while (!step.done) {
    seen.push(step.value.id);
    step = await chain.next();
  }
  return { seen, result: step.value };
}

test("with no team configured it does not run, so the worker still gets the work", async () => {
  const { result } = await runChain(speaking({}), {} as NodeJS.ProcessEnv);
  is(result.ran, false, "it reports that it did not run");
  is(result.files.length, 0, "and changes nothing");
});

test("the chain diagnoses, repairs, checks and records", async () => {
  const { seen, result } = await runChain(
    speaking({
      d1: "The page never declares a nav element.",
      d2: fixed,
      d3: "OK\nThe nav is present.",
      d4: "OK\nNothing else depends on it.",
      d6: "Added the missing navigation to the page.",
    }),
  );
  is(result.ran, true, "it ran");
  is(result.status, "repaired", "and the repair held");
  is(result.files.length, 1, "one file came back");
  is(result.files[0]?.path, "index.html", "the one that was wrong");
  ok(result.files[0]?.content.includes("<nav>Menu</nav>"), "carrying the correction");
  ok(result.summary.startsWith("Added the missing navigation"), `the record line is the summary: ${result.summary}`);
  ok(seen.includes("d1") && seen.includes("d2") && seen.includes("d3"), `each specialist reported: ${seen.join(",")}`);
});

test("a check that finds a problem is carried into the summary", async () => {
  const { result } = await runChain(
    speaking({
      d1: "No nav.",
      d2: fixed,
      d3: "OK\nThe nav is present.",
      d4: "PROBLEM\nThe stylesheet targets the old markup.",
      d6: "Added the navigation.",
    }),
  );
  is(result.status, "repaired", "the repair itself held");
  ok(result.summary.includes("stylesheet"), `the concern reaches the user: ${result.summary}`);
});

test("a fragment is refused rather than written over the page", async () => {
  // The failure that started all of this, in the repair path: a correction
  // that is only part of the file would replace the whole of it.
  const { result } = await runChain(speaking({ d1: "No nav.", d2: "<nav>Menu</nav>" }));
  is(result.status, "failed", "the repair is refused");
  is(result.files.length, 0, "and nothing is written");
  ok(result.summary.includes("fragment"), `the reason is stated: ${result.summary}`);
});

test("a repair that changed nothing is not reported as a repair", async () => {
  const { result } = await runChain(speaking({ d1: "No nav.", d2: original }));
  is(result.status, "failed", "an unchanged file is not a correction");
  is(result.files.length, 0, "nothing is written");
});

test("the team works with only the two specialists it needs", async () => {
  const two = {
    NOMIN_DOCTOR_1_API_KEY: "k",
    NOMIN_DOCTOR_2_API_KEY: "k",
  } as NodeJS.ProcessEnv;
  const { seen, result } = await runChain(speaking({ d1: "No nav.", d2: fixed }), two);
  is(result.status, "repaired", "diagnosis and repair are enough");
  ok(!seen.includes("d3"), "the specialists that are off duty are simply skipped");
});

suite("The manager's own line");

test("a manager note is shown but never sent to the model", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "Build a page", at: 1 },
    { role: "assistant", content: "Here.\n\n```html\n<p>a</p>\n```\n", at: 2 },
    { role: "user", content: "The review found this work incomplete.", internal: true, at: 3 },
    { role: "assistant", content: "Fixed.\n\n```html\n<p>b</p>\n```\n", at: 4 },
    { role: "assistant", content: "Checked and complete: 2 files.", manager: true, at: 5 },
  ];
  const outbound = messages.filter((message) => !message.manager);
  is(outbound.length, 4, "the note is left out of the request");
  ok(
    outbound.some((message) => message.content.includes("found this work incomplete")),
    "the sent-back brief still travels",
  );
  is(collectArtifacts(messages).length, 2, "the note is not scanned for artifacts");
});

void main();
