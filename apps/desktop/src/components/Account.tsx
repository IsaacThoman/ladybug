import { useState } from "react";
import type { FormEvent } from "react";
import { OfflineError, signIn, signOut } from "../api";
import type { OverlayLayout } from "../ladybug-api";
import type { Session } from "../session";

const STATUS_TEXT = {
  pending: "An admin still has to approve your account. I'll start watching your back as soon as they do.",
  rejected: "An admin turned down this account, so I can't check pages for you.",
} as const;

/** Sign-in panel on the overlay. Typing needs the window focused, so inputs ask for it. */
export default function Account({
  layout,
  session,
  onClose,
}: {
  layout: OverlayLayout;
  session: Session;
  onClose: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const mode = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.dataset.mode;
    setBusy(true);
    setError(null);
    try {
      await signIn(mode === "signup" ? "signup" : "login", username, password);
      setPassword("");
    } catch (err) {
      setError(err instanceof OfflineError ? "Can't reach the server…" : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const focus = () => window.ladybug.focusWindow();

  return (
    <div
      className="account-panel"
      data-overlay-interactive
      style={{ top: layout.workArea.y + 16, left: layout.workArea.x + 16, maxHeight: layout.workArea.height - 32 }}
    >
      {session ? (
        <>
          <p className="account-title">
            Signed in as <strong>{session.account.username}</strong>
          </p>
          {session.account.status !== "approved" && (
            <p className="account-status" data-status={session.account.status} role="status">
              {STATUS_TEXT[session.account.status]}
            </p>
          )}
          <div className="account-actions">
            <button type="button" onClick={onClose}>
              Close
            </button>
            <button type="button" className="secondary" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          <p className="account-title">Sign in to Computerbug</p>
          <p className="account-note">
            Once an admin approves your account, I'll warn you about unsafe pages your browser extension reports.
          </p>
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onPointerDown={focus}
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onPointerDown={focus}
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p className="account-error" role="alert">
              {error}
            </p>
          )}
          <div className="account-actions">
            <button type="submit" data-mode="login" disabled={busy}>
              Sign in
            </button>
            <button type="submit" data-mode="signup" className="secondary" disabled={busy}>
              Create account
            </button>
            <button type="button" className="link" onClick={onClose}>
              Not now
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
