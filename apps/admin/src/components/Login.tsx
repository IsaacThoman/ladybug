import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Garden, Ladybug, SpeechBubble, ladybugSnapshot } from "@ladybug/garden";
import type { BubbleTone, LadybugHandle, LadybugMood } from "@ladybug/garden";
import { ApiError, api } from "../api";

type Outcome = "idle" | "checking" | "wrong" | "locked" | "welcome";

/** How long the ladybug celebrates before the dashboard takes over. */
const WELCOME_MS = 1100;

export default function Login({
  unreachable,
  expired,
  onRetry,
  onSignedIn,
}: {
  unreachable: boolean;
  expired: boolean;
  onRetry: () => void;
  onSignedIn: () => void;
}) {
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [error, setError] = useState<string | null>(null);
  const bug = useRef<LadybugHandle>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (outcome !== "welcome") return;
    const timer = setTimeout(onSignedIn, WELCOME_MS);
    return () => clearTimeout(timer);
  }, [outcome, onSignedIn]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || outcome === "checking" || outcome === "welcome") return;
    setOutcome("checking");
    setError(null);
    try {
      await api.login(password);
      setOutcome("welcome");
      bug.current?.celebrate();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setOutcome(status === 429 ? "locked" : "wrong");
      setError(e instanceof Error && status ? e.message : "Can't reach the server. Is it running?");
      if (status === 429) bug.current?.alarm();
      else bug.current?.startle();
      setPassword("");
      input.current?.focus();
    }
  };

  let mood: LadybugMood = "calm";
  let say = "Password, please!";
  let tone: BubbleTone = "chat";
  if (unreachable) {
    mood = "nervous";
    say = "Hello? Is anyone there?";
    tone = "warn";
  } else if (outcome === "checking") {
    mood = "sniffing";
    say = "Sniff, sniff…";
  } else if (outcome === "welcome") {
    mood = "happy";
    say = "Welcome back!";
    tone = "ok";
  } else if (outcome === "locked") {
    mood = "alarmed";
    say = "Whoa, too many tries!";
    tone = "danger";
  } else if (outcome === "wrong") {
    mood = "nervous";
    say = "Hmm, that's not it.";
    tone = "warn";
  } else if (password) {
    say = "I'm not peeking!";
  } else if (expired) {
    say = "You were signed out.";
  }

  return (
    <div className="login">
      <Garden />
      <main className="login-main">
        <div className="login-card">
          <Ladybug ref={bug} className="login-bug" mood={mood} size={104} wander={unreachable ? 0 : 64}>
            <SpeechBubble text={say} tone={tone} />
          </Ladybug>
          <div className="login-brand">
            <img src={ladybugSnapshot} alt="" width={30} height={30} />
            <span className="brand-name">ladybug</span>
            <span className="brand-tag">admin</span>
          </div>
          {unreachable ? (
            <>
              <h1>The garden gate is stuck</h1>
              <p className="login-sub">
                The admin page can't reach the Ladybug server. Check that it's running, then try again.
              </p>
              <button type="button" className="login-submit" onClick={onRetry}>
                Try again
              </button>
            </>
          ) : (
            <>
              <h1>Welcome back, gardener</h1>
              <p className="login-sub">
                {expired
                  ? "Your session ended. Sign in again to keep tending the garden."
                  : "Sign in to look after the URL list, the activity log and the pets."}
              </p>
              <form className="login-form" onSubmit={submit}>
                {/* Lets password managers file the password under a name. */}
                <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
                <label htmlFor="admin-password">Admin password</label>
                <div className="password-field" data-invalid={outcome === "wrong" || outcome === "locked" || undefined}>
                  <input
                    ref={input}
                    id="admin-password"
                    name="password"
                    type={reveal ? "text" : "password"}
                    autoComplete="current-password"
                    autoFocus
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (outcome === "wrong") setOutcome("idle");
                    }}
                    aria-invalid={outcome === "wrong" || outcome === "locked"}
                    aria-describedby={error ? "login-error" : undefined}
                  />
                  <button
                    type="button"
                    className="reveal"
                    onClick={() => setReveal((v) => !v)}
                    aria-pressed={reveal}
                    aria-label={reveal ? "Hide password" : "Show password"}
                  >
                    {reveal ? "Hide" : "Show"}
                  </button>
                </div>
                {error && (
                  <p id="login-error" className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <button
                  type="submit"
                  className="login-submit"
                  disabled={!password || outcome === "checking" || outcome === "welcome"}
                >
                  {outcome === "checking" ? "Checking…" : outcome === "welcome" ? "Opening the gate…" : "Sign in"}
                </button>
              </form>
            </>
          )}
        </div>
        <p className="login-foot">
          The password is <code>ADMIN_PASSWORD</code> on the Ladybug server.
        </p>
      </main>
    </div>
  );
}
