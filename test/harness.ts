/**
 * A test harness small enough to read in one sitting.
 *
 * There is no framework here on purpose: the suite runs through esbuild and
 * node, both of which the build already depends on, so running the tests never
 * needs an install the build did not already need.
 */

import type { ChatRequest, Provider, StreamEvent } from "../src/model/types.js";

interface Case {
  name: string;
  run: () => Promise<void> | void;
}

const cases: Case[] = [];
let current = "";

export function test(name: string, run: () => Promise<void> | void): void {
  cases.push({ name, run });
}

/** Group label, printed once above the cases that follow it. */
export function suite(name: string): void {
  cases.push({ name: `\u0000${name}`, run: () => {} });
}

export function is<T>(actual: T, expected: T, what: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${what}\n    expected: ${format(expected)}\n    actual:   ${format(actual)}`);
  }
}

export function ok(value: unknown, what: string): void {
  if (!value) throw new Error(`${what}\n    expected something truthy, got ${format(value)}`);
}

const format = (value: unknown) =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

/**
 * A provider that plays a script.
 *
 * The bugs this suite guards against are all about how a turn reacts to what
 * the model returns — a finish reason, a truncated call, a round that ends
 * without saying why. None of that is reachable through a real provider on
 * demand, and all of it is exact through a script.
 */
export function scripted(script: StreamEvent[][]): Provider & { sent: ChatRequest[] } {
  let round = 0;
  const sent: ChatRequest[] = [];
  return {
    id: "nvidia",
    sent,
    async *stream(request: ChatRequest) {
      sent.push(request);
      const events = script[round] ?? [{ type: "done", finishReason: "stop" } as StreamEvent];
      round += 1;
      for (const event of events) yield event;
    },
  };
}

/** A tool call as the provider would stream it. */
export const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({
  type: "tool_call",
  call: { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
});

/** An approved plan. Its presence is what unlocks the tools. */
export const approvedPlan = () => ({
  understanding: "",
  objective: "build it",
  steps: [{ title: "write the files" }],
  files: [],
  assumptions: [],
  risks: [],
  testing: "",
  verification: "",
  output: "",
});

export async function main(): Promise<void> {
  let failed = 0;
  let passed = 0;

  for (const item of cases) {
    if (item.name.startsWith("\u0000")) {
      process.stdout.write(`\n${item.name.slice(1)}\n`);
      continue;
    }
    current = item.name;
    try {
      await item.run();
      passed += 1;
      process.stdout.write(`  ok    ${current}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`  FAIL  ${current}\n`);
      process.stdout.write(`        ${(error as Error).message.split("\n").join("\n        ")}\n`);
    }
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
