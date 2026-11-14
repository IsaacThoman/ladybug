import { useState } from "react";
import type { FormEvent } from "react";
import { ApiRequestError, signIn, signOut } from "../api.ts";
import type { Session } from "../session.ts";

/** Sign-in fields under the scan box, or who's signed in. */
export default function AccountBar({ session, highlight }: { session: Session; highlight: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session) {
    return (
      <div className="account-bar">
        <span className="account-name">
          Signed in as <strong>{session.account.username}</strong>
        </span>
        <button type="button" className="link-button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    );
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const mode = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.dataset.mode;
    setBusy(true);
    setError(null);
    try {
      await signIn(mode === "signup" ? "signup" : "login", username, password);
      setPassword("");
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.failure.kind === "unreachable"
          ? "Can't reach the ladybug server."
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="account-bar sign-in" onSubmit={submit}>
      <label className={`key-field${highlight ? " is-highlighted" : ""}`}>
        <span className="visually-hidden">Username</span>
        <input
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          required
        />
      </label>
      <label className={`key-field${highlight ? " is-highlighted" : ""}`}>
        <span className="visually-hidden">Password</span>
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <button type="submit" data-mode="login" className="button primary small" disabled={busy}>
        Sign in
      </button>
      <button type="submit" data-mode="signup" className="button ghost small" disabled={busy}>
        Create account
      </button>
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
