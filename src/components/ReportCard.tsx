import { useState } from "react";
import type { MonitorState } from "../lib/useMonitor.js";
import { Markdown } from "./Markdown.js";

/**
 * The brief handed back to the agent.
 *
 * It carries the exact text the page threw and the manager's own findings,
 * because "it is broken" is not something a model can act on, and a stack
 * message is.
 */
function fixBrief(monitor: MonitorState): string {
  const parts: string[] = [];
  if (monitor.reviewed) parts.push(`Fix ${monitor.reviewed}. Do not start over — edit the file that exists.`);
  if (monitor.runtimeErrors?.length) {
    parts.push(`It throws when the page loads:\n${monitor.runtimeErrors.map((error) => `- ${error}`).join("\n")}`);
  }
  const issues = monitor.verdict?.issues ?? [];
  if (issues.length) parts.push(`The review also found:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  parts.push("Read the file first, make the smallest change that fixes it, then say what you changed.");
  return parts.join("\n\n");
}

const LABEL: Record<string, string> = {
  verified: "Verified",
  unverified: "Unverified",
  concerns: "Concerns",
  failed: "Failed",
};

/**
 * The monitor's review, delivered in the conversation rather than filed away
 * in a panel — it is a second voice in the thread, so it reads as one: a
 * distinct speaker, clearly separated from Trion's own answer.
 *
 * It only ever states what was actually checked. "Unverified" is a real
 * outcome here, not a softer way of saying "fine".
 */
export function ReportCard({
  monitor,
  onFix,
  fixing,
}: {
  monitor: MonitorState;
  /** Hand the exact failure back to the agent. */
  onFix?: (brief: string) => void;
  fixing?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (monitor.status === "capturing" || monitor.status === "reviewing") {
    return (
      <aside className="report-card pending">
        <span className="report-spark" />
        {monitor.status === "capturing" ? "Rendering the result to review" : "Manager reviewing the work"}…
      </aside>
    );
  }

  const verdict = monitor.verdict;
  if (!verdict || monitor.status === "idle") return null;

  const hasDetail = Boolean(verdict.report) || verdict.issues.length > 0 || verdict.evidence.length > 0;

  return (
    <aside className={`report-card ${verdict.status}`}>
      <header className="report-card-head">
        <span className="report-who">Manager</span>
        <span className={`verdict ${verdict.status}`}>{LABEL[verdict.status] ?? verdict.status}</span>
        <span className="report-source">
          {verdict.usedModel
            ? verdict.sawRendering
              ? "reviewed the rendering"
              : "reviewed the record"
            : "evidence only"}
        </span>
      </header>

      <p className="report-card-summary">{verdict.summary}</p>

      {onFix && (monitor.runtimeErrors?.length || verdict.status === "concerns" || verdict.status === "failed") ? (
        <div className="report-actions">
          <button
            className="fix-btn"
            disabled={fixing}
            onClick={() => onFix(fixBrief(monitor))}
          >
            {fixing ? "Fixing…" : monitor.runtimeErrors?.length ? "Fix these errors" : "Address these findings"}
          </button>
          {monitor.runtimeErrors?.length ? (
            <span className="report-errors">
              {monitor.runtimeErrors.length} runtime error
              {monitor.runtimeErrors.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      ) : null}

      {hasDetail && (
        <button className="report-toggle" onClick={() => setOpen(!open)}>
          {open ? "Hide detail" : "Show detail"}
        </button>
      )}

      {open && (
        <div className="report-card-detail">
          {verdict.issues.length > 0 && (
            <ul className="report-issues">
              {verdict.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
          {verdict.report && <Markdown text={verdict.report} plain />}
          {verdict.evidence.length > 0 && (
            <p className="report-evidence">Checked: {verdict.evidence.join(" · ")}</p>
          )}
        </div>
      )}
    </aside>
  );
}
