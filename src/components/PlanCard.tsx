import { useState } from "react";
import type { Plan, PlanStatus } from "../model/plan.js";

/**
 * The plan, and the decision in front of it.
 *
 * Nothing is built until this is approved — not as a convention, but because
 * the agent is only handed tools once approval has happened. So the card is a
 * gate, and it says so: approve it, or send it back with what should change.
 */
export function PlanCard({
  plan,
  status,
  running,
  onApprove,
  onChange,
}: {
  plan: Plan;
  status: PlanStatus;
  running: boolean;
  onApprove: () => void;
  onChange: (note: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");

  const decided = status === "approved" || status === "changes-requested";

  return (
    <section className={`plan-card ${status}`}>
      <header className="plan-head">
        <span className="plan-label">Plan</span>
        {status === "approved" && <span className="verdict verified">Approved</span>}
        {status === "changes-requested" && <span className="verdict concerns">Changes sent</span>}
        {status === "proposed" && <span className="plan-gate">Waiting for your approval</span>}
      </header>

      {plan.understanding && <p className="plan-understanding">{plan.understanding}</p>}
      <p className="plan-objective">{plan.objective}</p>

      <ol className="plan-steps">
        {plan.steps.map((step, i) => (
          <li key={i}>
            <strong>{step.title}</strong>
            {step.detail && <span>{step.detail}</span>}
          </li>
        ))}
      </ol>

      <dl className="plan-facts">
        {plan.files.length > 0 && (
          <>
            <dt>Files</dt>
            <dd>{plan.files.join(", ")}</dd>
          </>
        )}
        {plan.testing && (
          <>
            <dt>Testing</dt>
            <dd>{plan.testing}</dd>
          </>
        )}
        {plan.verification && (
          <>
            <dt>Verification</dt>
            <dd>{plan.verification}</dd>
          </>
        )}
        {plan.assumptions.length > 0 && (
          <>
            <dt>Assuming</dt>
            <dd>{plan.assumptions.join(" · ")}</dd>
          </>
        )}
        {plan.risks.length > 0 && (
          <>
            <dt>Risks</dt>
            <dd>{plan.risks.join(" · ")}</dd>
          </>
        )}
      </dl>

      {!decided && !editing && (
        <footer className="plan-actions">
          <button className="ghost" onClick={() => setEditing(true)} disabled={running}>
            Request changes
          </button>
          <button className="primary" onClick={onApprove} disabled={running}>
            Approve and build
          </button>
        </footer>
      )}

      {!decided && editing && (
        <footer className="plan-edit">
          <textarea
            value={note}
            autoFocus
            rows={3}
            placeholder="What should change? e.g. use plain CSS, add a dark mode, skip the API"
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="plan-actions">
            <button className="ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="primary" onClick={() => onChange(note)} disabled={!note.trim()}>
              Send changes
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}
