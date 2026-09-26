/**
 * Tool calls that arrive as prose.
 *
 * Trion does not always use the structured `tool_calls` channel. Under load,
 * or when the chat template is asked to stop thinking, it writes the call it
 * wanted to make into the ordinary content stream instead — as
 * `[[{"name": "write_file", "parameters": {…}}]]`, or a fenced JSON block, or
 * a bare `{"tool": "read_file", "path": "deck.pptx"}`.
 *
 * Before this module existed, that text was the whole turn: the workspace
 * stayed empty, the canvas had nothing to show, and the user saw raw JSON
 * where an answer belonged. Rather than scold the model for it, the call is
 * taken at its word and executed. The intent was unambiguous; only the
 * envelope was wrong.
 *
 * Two details earn their complexity. The scan is brace-matched rather than
 * regular-expression based, because a `content` argument is usually an entire
 * HTML file and routinely contains braces and quotes of its own. And a call
 * cut off by the token limit is repaired rather than discarded — a truncated
 * `write_file` still carries most of a page, which is worth more than nothing.
 */

import type { ToolCall } from "./types.js";

export interface Harvest {
  calls: ToolCall[];
  /** What is left once the machinery is taken out — the real prose, if any. */
  text: string;
  /** True when a call was only recoverable by repairing truncated JSON. */
  repaired: boolean;
}

/** Keys a model has been seen to use for the tool's name and its arguments. */
const NAME_KEYS = ["name", "tool", "tool_name", "function", "action"];
const ARGUMENT_KEYS = ["parameters", "arguments", "args", "input", "parameter"];

/**
 * Pull every tool call out of a block of text.
 *
 * `allowed` is the set of tools the turn actually offered; anything else that
 * happens to look like a call — a JSON example inside an answer, say — is left
 * alone as prose.
 */
export function harvestToolCalls(text: string, allowed: readonly string[]): Harvest {
  if (!text.includes("{")) return { calls: [], text, repaired: false };

  const names = new Set(allowed);
  const calls: ToolCall[] = [];
  const cuts: Array<[number, number]> = [];
  let repaired = false;
  let index = 0;
  let serial = 0;

  while (index < text.length) {
    const start = text.indexOf("{", index);
    if (start === -1) break;

    const span = balancedEnd(text, start);
    const slice = text.slice(start, span.end);
    const value = parseLoosely(slice, span.truncated);

    if (value && isRecord(value)) {
      const call = toToolCall(value, names, serial);
      if (call) {
        calls.push(call);
        serial += 1;
        if (span.truncated) repaired = true;
        cuts.push([trimBack(text, start), trimForward(text, span.end)]);
        index = span.end;
        continue;
      }
    }

    index = start + 1;
  }

  if (!calls.length) return { calls: [], text, repaired: false };
  return { calls, text: withoutSpans(text, cuts), repaired };
}

/**
 * Parse an object out of text a model wrote by hand.
 *
 * The same forgiveness the tool harvest needs, offered to everything else that
 * reads model-authored JSON. A block with one brace too many at the end, or
 * one cut off by the token ceiling, is still the plan the model meant to send;
 * refusing it loses the whole turn over punctuation.
 */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to repair */
  }

  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  const span = balancedEnd(trimmed, start);
  return parseLoosely(trimmed.slice(start, span.end), span.truncated);
}

/**
 * Find where the object starting at `from` ends.
 *
 * Strings are tracked so that a brace inside a file's contents does not close
 * the object early. If the text runs out first the object was truncated by the
 * token limit, which the caller repairs rather than rejects.
 */
function balancedEnd(text: string, from: number): { end: number; truncated: boolean } {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = from; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return { end: i + 1, truncated: false };
    }
  }

  return { end: text.length, truncated: true };
}

/**
 * Parse an object, closing whatever the model did not get to finish.
 *
 * A cut-off call is the common case at the token ceiling: everything up to the
 * cut is real, so the string and the braces are closed and the partial file is
 * kept.
 */
function parseLoosely(slice: string, truncated: boolean): unknown {
  try {
    return JSON.parse(slice);
  } catch {
    if (!truncated) return null;
  }

  let body = slice;
  // A dangling escape would make the closing quote part of the escape.
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(body)) body = body.slice(0, -1);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of body) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
  }

  if (inString) body += '"';
  // Closing shape is unknown per level; objects are overwhelmingly the case
  // here, and a wrong guess simply fails to parse and is dropped.
  body += "}".repeat(Math.max(0, depth));

  try {
    return JSON.parse(body);
  } catch {
    // A real newline inside a string is invalid JSON, and a model writing out
    // an HTML file by hand produces them constantly. Escape them and retry.
    try {
      return JSON.parse(escapeControls(body));
    } catch {
      return null;
    }
  }
}

const ESCAPES: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** Escape the raw control characters a hand-written JSON string contains. */
function escapeControls(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString && !escaped && char < " ") {
      out += ESCAPES[char] ?? "";
      continue;
    }
    out += char;
    if (escaped) escaped = false;
    else if (inString && char === "\\") escaped = true;
    else if (char === '"') inString = !inString;
  }

  return out;
}

/** Turn a loose object into a real call, or reject it. */
function toToolCall(value: Record<string, unknown>, allowed: Set<string>, serial: number): ToolCall | null {
  const name = readName(value, allowed);
  if (!name) return null;

  let args = readArguments(value);
  if (args === null) {
    // `{"tool": "read_file", "path": "deck.pptx"}` — the arguments are inline.
    const rest: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (NAME_KEYS.includes(key) || ARGUMENT_KEYS.includes(key)) continue;
      rest[key] = item;
    }
    args = rest;
  }

  return {
    id: `text-${serial}-${name}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function readName(value: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of NAME_KEYS) {
    const found = value[key];
    if (typeof found === "string" && allowed.has(found)) return found;
    // OpenAI's own shape nests it: {"function": {"name": …}}.
    if (isRecord(found) && typeof found.name === "string" && allowed.has(found.name)) {
      return found.name;
    }
  }
  return null;
}

function readArguments(value: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ARGUMENT_KEYS) {
    const found = value[key];
    if (isRecord(found)) return found;
    // Some templates double-encode the arguments as a JSON string.
    if (typeof found === "string") {
      try {
        const parsed: unknown = JSON.parse(found);
        if (isRecord(parsed)) return parsed;
      } catch {
        /* not JSON; fall through */
      }
    }
  }
  const nested = value.function;
  if (isRecord(nested)) return readArguments(nested);
  return null;
}

/**
 * Walk back over the punctuation that introduced the call, so removing it does
 * not leave `[[` or a stray fence behind in the prose.
 */
function trimBack(text: string, start: number): number {
  let i = start;
  while (i > 0) {
    const before = text.slice(0, i);
    const fence = /(?:```(?:json|tool_code|tool_call)?\s*|[[\s,]|<\|?[A-Za-z_]+\|?>)$/.exec(before);
    if (!fence) break;
    i -= fence[0].length;
  }
  return i;
}

/** …and forward over the punctuation and fence that closed it. */
function trimForward(text: string, end: number): number {
  const after = /^(?:[\s\]),]|<\/?\|?[A-Za-z_]+\|?>)*(?:```)?/.exec(text.slice(end));
  return end + (after?.[0].length ?? 0);
}

/** Remove the harvested spans and tidy what the removal leaves behind. */
function withoutSpans(text: string, cuts: Array<[number, number]>): string {
  let out = "";
  let cursor = 0;
  for (const [from, to] of cuts) {
    if (from > cursor) out += text.slice(cursor, from);
    cursor = Math.max(cursor, to);
  }
  out += text.slice(cursor);

  return out
    .replace(/```(?:json|tool_code|tool_call)?\s*```/g, "")
    .replace(/^[\s\]\[,`]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Take a file out of the code fence a model wrapped it in.
 *
 * Asked for file contents, the model often answers the way it answers a person:
 * ```html, the page, ```. Passed straight through, those three backticks become
 * the first line of the file — which for an HTML page means the browser renders
 * them, and for anything compiled means a syntax error on line 1.
 *
 * Only a wrapper is removed: the fence has to open at the very start and close
 * at the very end with nothing after it, and there must be no other fence in
 * between. A markdown file that legitimately contains fenced blocks therefore
 * keeps every one of them.
 */
export function unfence(content: string): string {
  const trimmed = content.trim();
  const opening = /^```[^\n]*\n/.exec(trimmed);
  if (!opening || !trimmed.endsWith("```")) return content;

  const inner = trimmed.slice(opening[0].length, -3);
  if (inner.includes("```")) return content;
  return inner.replace(/\n[ \t]*$/, "");
}
