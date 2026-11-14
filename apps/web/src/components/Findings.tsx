import type { Severity } from "@ladybug/shared";
import { isImageKey } from "../format.ts";
import type { LiveFinding } from "../scanState.ts";

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

type Props = {
  findings: LiveFinding[];
  artifactSrc: (key: string) => string;
  running: boolean;
};

export default function Findings({ findings, artifactSrc, running }: Props) {
  const sorted = [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return (
    <section className="panel" aria-label="Findings">
      <h2 className="panel-title">
        Findings <span className="count">{findings.length}</span>
      </h2>
      {sorted.length === 0 ? (
        <p className="muted empty">{running ? "The agent hasn't reported anything yet." : "No findings."}</p>
      ) : (
        <ul className="findings">
          {sorted.map((f) => (
            <li key={f.id} className={`finding sev-${f.severity}`}>
              <div className="finding-head">
                <span className={`sev-badge sev-${f.severity}`}>{f.severity}</span>
                <h3>{f.title}</h3>
              </div>
              <p className="finding-evidence">{f.evidence}</p>
              {f.artifactKeys.length > 0 && (
                <div className="finding-artifacts">
                  {f.artifactKeys.map((key) =>
                    isImageKey(key) ? (
                      <a key={key} href={artifactSrc(key)} target="_blank" rel="noreferrer" className="artifact-thumb">
                        <img src={artifactSrc(key)} alt={key} loading="lazy" />
                      </a>
                    ) : (
                      <a key={key} href={artifactSrc(key)} target="_blank" rel="noreferrer" className="artifact-file">
                        {key.split("/").at(-1)}
                      </a>
                    ),
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
