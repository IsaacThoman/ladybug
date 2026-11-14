import type { ScanStatus } from "@ladybug/shared";

const STEPS = ["queued", "provisioning", "detonating", "investigating", "scoring", "done"] as const;

type Props = {
  status: ScanStatus;
  /** Last non-terminal status reached, to place a failure on the right step. */
  reached: ScanStatus | null;
  error: string | null;
};

export default function StatusStepper({ status, reached, error }: Props) {
  const failed = status === "failed";
  const current = failed
    ? STEPS.indexOf((reached ?? "queued") as (typeof STEPS)[number])
    : STEPS.indexOf(status as (typeof STEPS)[number]);

  return (
    <div className="stepper-wrap">
      <ol className={`stepper${failed ? " is-failed" : ""}`} aria-label="Scan progress">
        {STEPS.map((step, i) => {
          let state: "done" | "active" | "failed" | "todo" = "todo";
          if (failed) state = i < current ? "done" : i === current ? "failed" : "todo";
          else if (status === "done" || i < current) state = "done";
          else if (i === current) state = "active";
          return (
            <li key={step} className={`step step-${state}`} aria-current={state === "active" ? "step" : undefined}>
              <span className="step-dot" aria-hidden="true">
                {state === "done" ? "✓" : state === "failed" ? "✕" : ""}
              </span>
              <span className="step-label">{state === "failed" ? "failed" : step}</span>
            </li>
          );
        })}
      </ol>
      <p className="stepper-current" aria-hidden="true">
        {failed ? (
          "Failed"
        ) : (
          <>
            Step {current + 1} of {STEPS.length} · <span className="cap">{status}</span>
          </>
        )}
      </p>
      {failed && <p className="stepper-error">{error ?? "The scan failed."}</p>}
    </div>
  );
}
