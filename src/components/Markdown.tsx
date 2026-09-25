import { Fragment, useState, type ReactNode } from "react";

/**
 * A small, safe markdown renderer — enough for what the agent writes (code
 * blocks, headings, lists, bold, inline code) and nothing that needs raw HTML.
 */
export function Markdown({ text, plain = false }: { text: string; plain?: boolean }) {
  // A bare tool call is machinery, not prose. Showing it as an answer is how
  // {"tool":"read_file"} ends up on screen where a reply should be.
  if (!plain && isBareToolCall(text)) {
    return <p className="md-p md-machinery">Nomin tried to use a tool that was not available in that turn.</p>;
  }
  return <>{renderBlocks(text, plain)}</>;
}

function isBareToolCall(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || trimmed.length > 600) return false;
  return /"(tool|tool_name|function|name)"\s*:\s*"(read_file|write_file|list_files|run_command)"/.test(
    trimmed,
  );
}

function renderBlocks(text: string, plain = false): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  let list: string[] = [];
  let listKind: "ul" | "ol" = "ul";
  let code: string[] | null = null;
  let codeLang = "";

  const flushList = () => {
    if (!list.length) return;
    const Tag = listKind;
    out.push(
      <Tag key={`${listKind}-${out.length}`} className="md-list">
        {list.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </Tag>,
    );
    list = [];
    listKind = "ul";
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (code) {
        // nomin-questions blocks are internal protocol — never show them.
        if (!codeLang.startsWith("nomin-questions")) {
          out.push(<CodeTag key={`code-${out.length}`} info={codeLang} code={code.join("\n")} />);
        }
        code = null;
        codeLang = "";
      } else {
        flushList();
        code = [];
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet?.[1] !== undefined) {
      if (list.length && listKind !== "ul") flushList();
      listKind = "ul";
      list.push(bullet[1]);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered?.[1] !== undefined) {
      if (list.length && listKind !== "ol") flushList();
      listKind = "ol";
      list.push(numbered[1]);
      continue;
    }
    flushList();

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading?.[2] !== undefined) {
      const level = heading[1]!.length;
      out.push(
        <p key={`h-${out.length}`} className={`md-h md-h${level}`}>
          {renderInline(heading[2])}
        </p>,
      );
      continue;
    }

    if (!line.trim()) {
      out.push(<div key={`sp-${out.length}`} className="md-gap" />);
      continue;
    }
    out.push(
      <p key={`p-${out.length}`} className="md-p">
        {renderInline(line)}
      </p>,
    );
  }

  flushList();
  if (code) {
    // Still streaming in — show it as a tag that is being written.
    // nomin-questions blocks are internal protocol — hide them even while streaming.
    if (!codeLang.startsWith("nomin-questions")) {
      out.push(<CodeTag key={`code-${out.length}`} info={codeLang} code={code.join("\n")} streaming />);
    }
  }
  return out;
}

/**
 * A file the agent wrote, shown the way an action reads rather than as a wall
 * of source: one line saying what was produced, openable if you want to look.
 * The full file is always available in the canvas.
 */
function CodeTag({ info, code, streaming }: { info: string; code: string; streaming?: boolean }) {
  // Nomin's own protocol blocks are not deliverables and never show as files.
  if (info.trim().startsWith("nomin-")) return null;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [langRaw, ...rest] = info.trim().split(/\s+/);
  const lang = (langRaw ?? "").toLowerCase();
  const name = rest.find((part) => part.includes(".")) ?? fallbackName(lang);
  const lines = code ? code.split("\n").length : 0;

  return (
    <div className={`code-tag${open ? " open" : ""}${streaming ? " streaming" : ""}`}>
      <button className="code-tag-head" onClick={() => setOpen(!open)} type="button">
        <span className="code-tag-verb">{streaming ? "Writing" : "Wrote"}</span>
        <span className="code-tag-name">{name}</span>
        <span className="code-tag-meta">
          +{lines} {lang || "text"}
        </span>
        <span className={`caret-icon${open ? " up" : ""}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="code-tag-body">
          <div className="code-tag-bar">
            <span>{name}</span>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(code);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }}
              type="button"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="md-code">
            <code>{code}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

const FALLBACK: Record<string, string> = {
  html: "index.html",
  css: "styles.css",
  js: "script.js",
  javascript: "script.js",
  ts: "main.ts",
  tsx: "App.tsx",
  jsx: "App.jsx",
  json: "data.json",
  py: "main.py",
  python: "main.py",
  sh: "run.sh",
  bash: "run.sh",
};

const fallbackName = (lang: string) => FALLBACK[lang] ?? (lang ? `snippet.${lang}` : "snippet");

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;

function renderInline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code key={i} className="md-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
