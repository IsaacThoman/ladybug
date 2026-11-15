import type { ReactNode } from "react";
import { LadybugMark } from "@ladybug/mascot/react";
import adminChart from "../assets/landing/admin-chart.webp";
import adminUrls from "../assets/landing/admin-urls.webp";
import desktopBlocked from "../assets/landing/desktop-blocked.webp";
import desktopChecking from "../assets/landing/desktop-checking.webp";
import extensionPopup from "../assets/landing/extension-popup.webp";
import petMenu from "../assets/landing/pet-menu.webp";
import reportAgent from "../assets/landing/report-agent.webp";
import reportFindings from "../assets/landing/report-findings.webp";
import reportLive from "../assets/landing/report-live.webp";
import reportScreens from "../assets/landing/report-screens.webp";
import reportSignals from "../assets/landing/report-signals.webp";
import reportSummary from "../assets/landing/report-summary.webp";
import reportVerdict from "../assets/landing/report-verdict.webp";
import Link from "./Link.tsx";

// The story under the hero: why Computerbug exists and what it does, told
// with screenshots of the app itself. The scan shown is the recorded demo at
// /demo, so the bank in it (Northwind) is made up.

/** The page the screenshots follow from the browser to the family's phone. */
const UNSAFE_URL = "https://northwlnd-secure.top/signin/?session=8f3c21e0b7";

type ShotProps = {
  src: string;
  /** Pixel size of the file, so the page doesn't jump as images load. */
  size: [width: number, height: number];
  alt: string;
  /** "screen": a whole screen, framed. "card": one panel, cut out with its own shadow. */
  kind?: "screen" | "card";
  className?: string;
};

function Shot({ src, size, alt, kind = "card", className }: ShotProps) {
  return (
    <img
      className={`shot shot-${kind}${className ? ` ${className}` : ""}`}
      src={src}
      width={size[0]}
      height={size[1]}
      alt={alt}
      loading="lazy"
      decoding="async"
    />
  );
}

/** A screenshot of a web page, in a browser window. */
function BrowserShot({ url, ...shot }: ShotProps & { url: string }) {
  return (
    <div className="shot-window">
      <div className="shot-window-bar" aria-hidden="true">
        <span className="shot-window-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="shot-window-url mono">{url}</span>
      </div>
      <Shot {...shot} kind="screen" />
    </div>
  );
}

type StepProps = {
  n: number;
  title: string;
  /** "wide": the words above full-width pictures. "split flip": the picture beside the words, picture first. */
  layout?: "wide" | "split flip";
  children: ReactNode;
  figure: ReactNode;
};

function Step({ n, title, layout = "wide", children, figure }: StepProps) {
  return (
    <li className={`how-step ${layout}`}>
      <div className="how-copy">
        <span className="how-num" aria-hidden="true">
          {n}
        </span>
        <h3 className="how-title">{title}</h3>
        {children}
      </div>
      <div className="how-figure">{figure}</div>
    </li>
  );
}

export default function Story() {
  return (
    <div className="story" id="story">
      <section className="story-why" aria-labelledby="story-why-title">
        <p className="eyebrow">Inspiration</p>
        <h2 id="story-why-title" className="story-title">
          We're the tech support in our families.
        </h2>
        <p className="story-lede">
          We built Computerbug after playing tech support for family members. We've helped on many calls from relatives
          asking about a suspicious website, and we wanted an easier way to step in and help directly.
        </p>
      </section>

      <section aria-labelledby="story-what-title">
        <p className="eyebrow">What it does</p>
        <h2 id="story-what-title" className="story-title">
          It watches the browser, and calls for family when something's wrong.
        </h2>

        <ol className="how-steps">
          <Step
            n={1}
            title="A ladybug on the desktop, an extension in the browser"
            figure={
              <figure className="shot-figure">
                <div className="shot-stack">
                  <Shot
                    kind="screen"
                    src={desktopChecking}
                    size={[2400, 1500]}
                    alt="A browser on a sign-in page for a bank. The extension's toolbar icon shows it is checking the page, and the ladybug in the corner of the desktop holds a magnifying glass."
                  />
                  <Shot
                    kind="screen"
                    className="shot-float"
                    src={extensionPopup}
                    size={[680, 676]}
                    alt="The extension's popup: connected, signed in as grandma, reporting the pages visited, with a list of recent pages marked safe or unsafe."
                  />
                </div>
                <figcaption>
                  The ladybug gets its magnifying glass out while a page is checked. Inset: the extension's popup.
                </figcaption>
              </figure>
            }
          >
            <p>
              Computerbug is a desktop app that pairs with a browser extension. The extension reads the sites you go to
              and sends them to our backend for analysis, while the ladybug keeps you company on screen.
            </p>
          </Step>

          <Step
            n={2}
            title="Pages it knows get an answer straight away"
            figure={
              <figure className="shot-figure">
                <Shot
                  className="shot-fade"
                  src={adminUrls}
                  size={[2400, 1349]}
                  alt="The admin's URL database: a search box over a table of pages and hosts, each with a safe or unsafe verdict, the reason and when it was checked."
                />
                <figcaption>The URL database in the admin, searched in Typesense.</figcaption>
              </figure>
            }
          >
            <p>
              On our Vultr backend, every page is looked up in Typesense first. A page we've seen before is recognised
              at once: nothing happens for a safe one, and a dangerous one is blocked.
            </p>
          </Step>

          <Step
            n={3}
            title="Pages it doesn't know are detonated"
            figure={
              <>
                <figure className="shot-figure">
                  <BrowserShot
                    url="computerbug.garden/scans/…"
                    src={reportLive}
                    size={[2400, 1500]}
                    alt="A live scan report, part-way through: the page under investigation on the left, findings and the agent's activity filling in on the right."
                  />
                  <figcaption>
                    A scan as it runs. Every one has a live report like this. Northwind Bank is made up.
                  </figcaption>
                </figure>
                <div className="shot-columns">
                  <div className="shot-column">
                    <Shot
                      src={reportAgent}
                      size={[1174, 762]}
                      alt="The agent's activity log: reading the DOM, taking a screenshot, checking page behaviour, running a command on a file, and typing fake credentials into the sign-in form."
                    />
                    <Shot
                      src={reportScreens}
                      size={[1710, 1360]}
                      alt="Screenshots from inside the sandbox, ending on a page the agent reached that asks for a card number, expiry, CVV and ATM PIN."
                    />
                  </div>
                  <div className="shot-column">
                    <Shot
                      src={reportFindings}
                      size={[1174, 1968]}
                      alt="Six findings, from high to info: impersonates a bank, credentials sent to an unrelated host, asks for SMS code and full card details, an obfuscated keystroke logger, a threat of account suspension, and blocked devtools."
                    />
                  </div>
                </div>
              </>
            }
          >
            <p>
              When Typesense doesn't recognise a page, we detonate it: open it in a throwaway browser on the backend and
              run a Gemini agent loop. Gemini can navigate the browser, inspect the DOM, inspect the traffic, inspect
              files, take notes, and much more.
            </p>
            <p>
              <Link href="/demo" className="story-link">
                Watch a recorded scan →
              </Link>
            </p>
          </Step>

          <Step
            n={4}
            title="What it finds is kept, with a fingerprint of the page"
            figure={
              <>
                <Shot
                  src={reportVerdict}
                  size={[2400, 408]}
                  alt="The top of a finished report: the scanned link, each stage ticked off from queued to done, and a score of 83 out of 100, malicious, high confidence."
                />
                <div className="shot-columns">
                  <Shot
                    src={reportSummary}
                    size={[1174, 844]}
                    alt="The report's summary: a credential-phishing kit impersonating a bank, with a signal score of 70, an agent score of 96 and a final score of 83."
                  />
                  <Shot
                    src={reportSignals}
                    size={[1174, 818]}
                    alt="The signals behind the score: the credential form posts to a different domain, the page looks like a well-known brand, the domain is under 30 days old, and the JavaScript is heavily obfuscated."
                  />
                </div>
                <figure className="shot-figure">
                  <Shot
                    src={adminChart}
                    size={[2400, 800]}
                    alt="A stacked bar chart of visits checked over the last hour, split into known unsafe, unknown and analysed, and known safe."
                  />
                  <figcaption>Every visit checked, charted in the admin from TimescaleDB.</figcaption>
                </figure>
              </>
            }
          >
            <p>
              The findings are entered into TimescaleDB, alongside a vector fingerprint derived from the page's title,
              text and structure. The fingerprint, along with Typesense search, quickly identifies identical or
              near-identical malicious sites across domains.
            </p>
          </Step>

          <Step
            n={5}
            title="A malicious page is blocked"
            figure={
              <figure className="shot-figure">
                <Shot
                  kind="screen"
                  src={desktopBlocked}
                  size={[2400, 1500]}
                  alt="The same browser, now showing a brown page that says Blocked. Beside it the ladybug covers its face under a speech bubble: this page turned out to be dangerous, with buttons to get out or continue anyway."
                />
                <figcaption>The page is covered in the browser, and the ladybug has the details.</figcaption>
              </figure>
            }
          >
            <p>
              When a malicious site is detected, Computerbug blocks it. The ladybug says what it found, and offers a way
              out.
            </p>
          </Step>

          <Step
            n={6}
            layout="split flip"
            title="And someone you trust gets a text"
            figure={<FamilyText />}
          >
            <p>
              Computerbug also uses Chert to send an iMessage to trusted family members. From there, Chert lets them
              step in with a one-word reply:
            </p>
            <dl className="replies">
              <div>
                <dt className="mono">SUPPORT</dt>
                <dd>Video call directly into the computer, with its screen shared.</dd>
              </div>
              <div>
                <dt className="mono">KILL</dt>
                <dd>Close the offending browser.</dd>
              </div>
              <div>
                <dt className="mono">SHUTDOWN</dt>
                <dd>Shut the machine down.</dd>
              </div>
            </dl>
            <div className="ask">
              <Shot
                src={petMenu}
                size={[464, 404]}
                alt="The ladybug with its menu open: Request help, and Scan clipboard URL."
              />
              <p>It works the other way too: click the ladybug and pick Request help to start the call yourself.</p>
            </div>
          </Step>
        </ol>
      </section>
    </div>
  );
}

/** What the server texts a trusted contact (apps/server/src/support/chert.ts), and one of the replies. */
function FamilyText() {
  return (
    <figure className="shot-figure">
      <div className="texts">
        <p className="texts-from">
          <LadybugMark size={26} />
          Computerbug
        </p>
        <p className="text-bubble in">
          The user is accessing a website that might not be trustworthy:
          <span className="text-url mono">{UNSAFE_URL}</span>
          Reply within 30 minutes:
          <span className="text-line">SUPPORT: Start a remote FaceTime support call.</span>
          <span className="text-line">KILL: Force-close Google Chrome.</span>
          <span className="text-line">SHUTDOWN: Shut down. Unsaved work may be lost.</span>
        </p>
        <p className="text-bubble out">SUPPORT</p>
      </div>
      <figcaption>The text a trusted contact gets, and one of the three replies.</figcaption>
    </figure>
  );
}
