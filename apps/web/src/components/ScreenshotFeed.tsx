import { useState } from "react";
import type { LiveScreenshot } from "../scanState.ts";

type Props = {
  screenshots: LiveScreenshot[];
  artifactSrc: (key: string) => string;
  running: boolean;
  status: string;
};

export default function ScreenshotFeed({ screenshots, artifactSrc, running, status }: Props) {
  const [pinned, setPinned] = useState<string | null>(null);
  const latest = screenshots.at(-1) ?? null;
  const selected = screenshots.find((s) => s.artifactKey === pinned) ?? latest;
  const isLatest = selected?.artifactKey === latest?.artifactKey;
  const isLive = selected !== null && isLatest && running;

  return (
    <section className="panel feed" aria-label="Screenshots">
      <div className="feed-stage">
        {selected ? (
          <>
            <img
              key={selected.artifactKey}
              className="feed-image"
              src={artifactSrc(selected.artifactKey)}
              alt={`Screenshot of the page, ${selected.label}`}
            />
            <div className="feed-caption">
              {isLive && <span className="live-dot">live</span>}
              <span className="feed-label">{selected.label}</span>
              {!isLatest && (
                <button type="button" className="feed-follow" onClick={() => setPinned(null)}>
                  Follow latest
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="feed-empty">
            <div className="feed-empty-browser" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p>{running ? waitingCopy(status) : "No screenshots were captured."}</p>
          </div>
        )}
      </div>
      {screenshots.length > 1 && (
        <ol className="filmstrip" aria-label="Earlier screenshots">
          {screenshots.map((shot) => (
            <li key={shot.artifactKey}>
              <button
                type="button"
                className={`thumb${shot.artifactKey === selected?.artifactKey ? " is-selected" : ""}`}
                onClick={() => setPinned(shot.artifactKey === latest?.artifactKey ? null : shot.artifactKey)}
                aria-pressed={shot.artifactKey === selected?.artifactKey}
              >
                <img src={artifactSrc(shot.artifactKey)} alt="" loading="lazy" />
                <span>{shot.label}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function waitingCopy(status: string) {
  if (status === "queued") return "Waiting for a sandbox…";
  if (status === "provisioning") return "Spinning up a disposable browser…";
  return "Opening the page in the sandbox…";
}
