import type { ChatMessage } from "./useAgent.js";

/**
 * Artifacts are pulled from what the agent actually wrote — fenced code blocks
 * in its answers — rather than being invented by the UI. A block becomes a
 * file; a set of files becomes something the canvas can run.
 */
export interface Artifact {
  /** File name, taken from the fence info string when the agent gives one. */
  name: string;
  lang: string;
  code: string;
  /** Index of the message it came from, newest last. */
  turn: number;
  /** True while the fence is still open — the file is mid-write. */
  partial?: boolean;
}

export type CanvasKind = "html" | "project" | "code" | "empty";

export interface CanvasState {
  kind: CanvasKind;
  artifacts: Artifact[];
  /** The single document to render, when the canvas can render one. */
  document?: string;
  /** Why nothing is running, in plain words. */
  reason?: string;
}

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

const EXT: Record<string, string> = {
  html: "html",
  css: "css",
  js: "js",
  javascript: "js",
  jsx: "jsx",
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  json: "json",
  md: "md",
  markdown: "md",
  py: "py",
  python: "py",
  sh: "sh",
  bash: "sh",
  react: "jsx",
  vue: "vue",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  rust: "rs",
  go: "go",
  ruby: "rb",
  java: "java",
  kotlin: "kt",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
};

/**
 * Languages that describe work rather than being work. A model listing its
 * plan in a ```markdown fence has not produced a file, and counting those as
 * deliverables is how a turn that wrote nothing reports "18 files".
 */
const PROSE = new Set(["md", "markdown", "text", "txt", "plaintext", "console", "output", "log", "diff", "tree"]);

/** Does this block contain a whole HTML document, whatever it was labelled? */
function isDocument(file: Artifact): boolean {
  if (file.lang === "html" || file.name.endsWith(".html")) return true;
  const head = file.code.slice(0, 600).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html");
}

/** Files still being written, which nothing should judge as delivered. */
export const isDraft = (file: Artifact) => Boolean(file.partial);

/** Pull every code block out of the assistant's answers, newest turn last. */
export function collectArtifacts(messages: ChatMessage[]): Artifact[] {
  const artifacts: Artifact[] = [];
  messages.forEach((message, turn) => {
    if (message.role !== "assistant" || message.error) return;
    for (const match of message.content.matchAll(FENCE)) {
      const info = (match[1] ?? "").trim();
      const code = (match[2] ?? "").trimEnd();
      if (!code.trim()) continue;
      // nomin-questions blocks are internal protocol — never surface as artifacts.
      if (info.startsWith("nomin-questions") || info.startsWith("nomin-plan")) continue;
      const [langRaw, ...rest] = info.split(/\s+/);
      const lang = (langRaw ?? "").toLowerCase();
      // ```ts src/app.ts  → the second token is a filename
      const named = rest.find((part) => part.includes("."));
      if (PROSE.has(lang) && !named) continue;
      const ext = EXT[lang] ?? (lang || "txt");
      artifacts.push({
        name: named ?? `snippet-${artifacts.length + 1}.${ext}`,
        lang: lang || "text",
        code,
        turn,
      });
    }

    // A fence that never closed is still real work — a long build spends most
    // of its time inside one. Treat it as a file in progress so the canvas can
    // show it instead of waiting for a closing marker that may never come.
    const open = openFence(message.content);
    if (open && !open.info.startsWith("nomin-")) {
      const [langRaw, ...rest] = open.info.split(/\s+/);
      const lang = (langRaw ?? "").toLowerCase();
      const named = rest.find((part) => part.includes("."));
      if (PROSE.has(lang) && !named) return;
      const ext = EXT[lang] ?? (lang || "txt");
      artifacts.push({
        name: named ?? `draft-${artifacts.length + 1}.${ext}`,
        lang: lang || "text",
        code: open.code,
        turn,
        partial: true,
      });
    }
  });
  return artifacts;
}

/** The trailing, still-unclosed fence in a message, if there is one. */
export function openFence(text: string): { info: string; code: string } | null {
  const marks = [...text.matchAll(/```/g)];
  if (marks.length % 2 === 0) return null;
  const last = marks[marks.length - 1]!;
  const rest = text.slice(last.index! + 3);
  const newline = rest.indexOf("\n");
  if (newline === -1) return null;
  const code = rest.slice(newline + 1);
  if (!code.trim()) return null;
  return { info: rest.slice(0, newline).trim(), code };
}

/**
 * Decide what the canvas can do with them. The rules are deliberately strict:
 * the canvas only claims it can run something when it really can.
 */
export function readCanvas(messages: ChatMessage[]): CanvasState {
  const artifacts = collectArtifacts(messages);
  if (!artifacts.length) {
    return { kind: "empty", artifacts, reason: "Nothing has been produced yet." };
  }

  const hasPackage = artifacts.some((file) => file.name.endsWith("package.json"));
  if (hasPackage) return { kind: "project", artifacts };

  // Newest page wins. Detection is by content as well as by label: models
  // routinely fence a full document as ```css, ```txt or with no language at
  // all, and refusing to run it because of the label would be pedantic.
  const html = [...artifacts].reverse().find(isDocument);
  if (html) return { kind: "html", artifacts, document: assemble(html, artifacts) };

  // A stylesheet or a script with no page is still previewable — wrap it in a
  // minimal host document so the work can actually be seen.
  const css = [...artifacts].reverse().find((file) => file.lang === "css" || file.name.endsWith(".css"));
  if (css) {
    return { kind: "html", artifacts, document: hostDocument(css, artifacts) };
  }

  return {
    kind: "code",
    artifacts,
    reason: "These files are not a runnable web page on their own.",
  };
}

/**
 * A page for orphaned CSS or JS: enough scaffolding to show what the styles
 * actually look like, clearly marked as a preview host rather than pretending
 * the agent wrote it.
 */
function hostDocument(css: Artifact, artifacts: Artifact[]): string {
  const js = artifacts
    .filter((file) => file.turn === css.turn && (file.lang === "js" || file.lang === "javascript"))
    .map((file) => file.code)
    .join("\n\n");
  return [
    "<!doctype html><html><head><meta charset='utf-8'>",
    "<meta name='viewport' content='width=device-width, initial-scale=1'>",
    `<style>${css.code}</style></head><body>`,
    "<main class='container'><h1>Preview</h1><p>Stylesheet preview host.</p>",
    "<button class='btn btn-primary'>Primary</button></main>",
    js ? `<script>${js}</script>` : "",
    "</body></html>",
  ].join("");
}

/**
 * Inline the CSS and JS blocks from the same answer, so a page split across
 * three fences still renders as one document.
 */
function assemble(html: Artifact, artifacts: Artifact[]): string {
  const siblings = artifacts.filter((file) => file.turn === html.turn && file !== html);
  const css = siblings.filter((file) => file.lang === "css").map((file) => file.code);
  const js = siblings
    .filter((file) => file.lang === "js" || file.lang === "javascript")
    .map((file) => file.code);

  let document = html.code;
  if (css.length) {
    const style = `<style>\n${css.join("\n\n")}\n</style>`;
    document = document.includes("</head>")
      ? document.replace("</head>", `${style}\n</head>`)
      : `${style}\n${document}`;
  }
  if (js.length) {
    const script = `<script>\n${js.join("\n\n")}\n</script>`;
    document = document.includes("</body>")
      ? document.replace("</body>", `${script}\n</body>`)
      : `${document}\n${script}`;
  }
  return document;
}
