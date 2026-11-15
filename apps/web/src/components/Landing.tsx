import { LadybugMark } from "@ladybug/mascot/react";
import Link from "./Link.tsx";
import VerdictChip from "./VerdictChip.tsx";

/** The tools the scan agent can reach for inside the sandbox. */
const AGENT_TOOLS = [
  "Navigate & click",
  "Fill in forms",
  "Read the DOM",
  "Watch network traffic",
  "Open downloaded files",
  "Run shell commands",
  "Look up domains & hashes",
  "Take notes",
];

/** Takes the visitor back up to the scan box at the top of the page. */
function focusScanInput() {
  const input = document.getElementById("scan-url");
  input?.focus({ preventScroll: true });
  input?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/** The story half of the home page: why computerbug exists and how it works. */
export default function Landing() {
  return (
    <div className="landing">
      <Story />
      <Pipeline />
      <Fingerprints />
      <FamilyAlert />
      <section className="landing-cta" aria-labelledby="cta-title">
        <h2 id="cta-title" className="landing-title">
          Have a link you're unsure about?
        </h2>
        <p className="landing-lede">Paste it at the top of the page, or watch a recorded scan from start to finish.</p>
        <div className="landing-cta-actions">
          <button type="button" className="button primary" onClick={focusScanInput}>
            Scan a link
          </button>
          <Link href="/demo" className="button ghost">
            Watch a recorded scan
          </Link>
        </div>
      </section>
    </div>
  );
}

function Story() {
  return (
    <section className="landing-section landing-story" aria-labelledby="story-title">
      <div className="landing-copy">
        <p className="landing-eyebrow">Why we built it</p>
        <h2 id="story-title" className="landing-title">
          We kept answering the same phone call.
        </h2>
        <p className="landing-lede">
          Plenty of us are the family's tech support. The call usually starts with “is this website real?” and ends
          with us trying to make sense of a page we can't see, on a computer we can't touch.
        </p>
        <p className="landing-lede">
          Computerbug checks those pages before anyone has to call, and when something is wrong, it brings you
          straight to the computer that needs help.
        </p>
      </div>
      <figure className="chat-card" aria-label="An example text from a family member">
        <figcaption className="chat-head">
          <span className="chat-avatar" aria-hidden="true">
            M
          </span>
          Mom
        </figcaption>
        <p className="chat-bubble them">it says my computer has a virus and i need to call microsoft??</p>
        <p className="chat-bubble them">there's a number on the screen. should i call it</p>
        <p className="chat-bubble me">don't call it! what's the website</p>
        <p className="chat-bubble them">i don't know how to find that</p>
      </figure>
    </section>
  );
}

function Pipeline() {
  return (
    <section className="landing-section" aria-labelledby="pipeline-title">
      <div className="landing-copy centered">
        <p className="landing-eyebrow">What it does</p>
        <h2 id="pipeline-title" className="landing-title">
          From the page you're on to a verdict
        </h2>
        <p className="landing-lede">
          A browser extension paired with the Computerbug desktop app reads the sites you visit and sends them to our
          backend on Vultr for analysis.
        </p>
      </div>
      <ol className="pipeline">
        <li className="pipeline-step">
          <span className="pipeline-num">1</span>
          <h3>Read the page</h3>
          <p>
            The extension sends each page you open to the backend through the desktop app, which also stays on screen
            as a ladybug that reacts to what it finds.
          </p>
        </li>
        <li className="pipeline-step">
          <span className="pipeline-num">2</span>
          <h3>Check what we've seen</h3>
          <p>
            A Typesense query compares the page against everything already scanned. A known page gets its answer right
            away.
          </p>
        </li>
        <li className="pipeline-step wide">
          <span className="pipeline-num">3</span>
          <h3>Detonate the unknown ones</h3>
          <p>
            Pages we don't recognize are opened in a disposable sandboxed browser, where a Gemini agent works through
            the page in a loop. It decides what to try next, writes down what it finds, and finishes with a scored
            report.
          </p>
          <ul className="tool-chips" aria-label="What the agent can do">
            {AGENT_TOOLS.map((tool) => (
              <li key={tool}>{tool}</li>
            ))}
          </ul>
        </li>
        <li className="pipeline-step">
          <span className="pipeline-num">4</span>
          <h3>Remember it</h3>
          <p>
            Findings go into TimescaleDB with a vector fingerprint of the page, so the next copy of it is caught
            instantly.
          </p>
        </li>
        <li className="pipeline-step alert">
          <span className="pipeline-num">5</span>
          <h3>Block it and tell family</h3>
          <p>A malicious page is blocked on the spot, and trusted family members get an iMessage about it.</p>
        </li>
      </ol>
    </section>
  );
}

function Fingerprints() {
  return (
    <section className="landing-section landing-split" aria-labelledby="fingerprint-title">
      <div className="landing-copy">
        <p className="landing-eyebrow">Fingerprints</p>
        <h2 id="fingerprint-title" className="landing-title">
          A new domain doesn't make it a new scam.
        </h2>
        <p className="landing-lede">
          Scammers copy the same page to fresh domains all the time. Every scanned page gets a vector fingerprint
          built from its title, its text and its structure.
        </p>
        <p className="landing-lede">
          Together with Typesense search, that fingerprint matches identical and near-identical pages across domains,
          so a copy is recognized without being scanned from scratch.
        </p>
      </div>
      <figure className="match-card" aria-label="Example: two domains matched to the same page">
        <div className="match-page">
          <span className="match-label">Scanned last week</span>
          <span className="mono match-host">secure-billing-help.com</span>
          <span className="match-title">“Your account has been suspended”</span>
          <VerdictChip verdict="malicious" />
        </div>
        <div className="match-link" aria-hidden="true">
          <span className="match-line" />
          <span className="match-score">same fingerprint</span>
          <span className="match-line" />
        </div>
        <div className="match-page">
          <span className="match-label">Opened today</span>
          <span className="mono match-host">account-restore-center.net</span>
          <span className="match-title">“Your account has been suspended”</span>
          <VerdictChip verdict="malicious" />
        </div>
        <figcaption className="match-note">Illustrative example</figcaption>
      </figure>
    </section>
  );
}

function FamilyAlert() {
  return (
    <section className="landing-section landing-split reverse" aria-labelledby="family-title">
      <div className="landing-copy">
        <p className="landing-eyebrow">When something's wrong</p>
        <h2 id="family-title" className="landing-title">
          The person who'd get the call hears about it first.
        </h2>
        <p className="landing-lede">
          When Computerbug blocks a malicious site, it uses Chert to text the trusted family members on the account.
          They can answer right from iMessage:
        </p>
        <ul className="family-actions">
          <li>
            <strong>Video call in</strong>
            <span>Start a FaceTime call that shares the computer's screen, so you can talk them through it.</span>
          </li>
          <li>
            <strong>Close the browser</strong>
            <span>Force-close the browser that has the page open.</span>
          </li>
          <li>
            <strong>Shut it down</strong>
            <span>Turn the computer off when it's safest to stop everything.</span>
          </li>
        </ul>
      </div>
      <figure className="chat-card phone" aria-label="An example alert sent to a family member">
        <figcaption className="chat-head">
          <LadybugMark size={30} className="chat-mark" />
          Computerbug
        </figcaption>
        <p className="chat-bubble them">
          The user is accessing a website that might not be trustworthy:
          <span className="mono chat-url">support-microsoft-alert.com</span>
          Reply within 30 minutes:
          <br />
          <b>SUPPORT</b>: Start a remote FaceTime support call.
          <br />
          <b>KILL</b>: Force-close Google Chrome.
          <br />
          <b>SHUTDOWN</b>: Shut down. Unsaved work may be lost.
        </p>
        <p className="chat-bubble me">SUPPORT</p>
        <p className="chat-status">Starting a FaceTime call with Mom's computer…</p>
      </figure>
    </section>
  );
}
