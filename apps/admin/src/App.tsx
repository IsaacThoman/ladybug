import { useCallback, useEffect, useState } from "react";
import { Garden } from "@ladybug/garden";
import { api, onSignedOut } from "./api";
import Dashboard from "./components/Dashboard";
import Login from "./components/Login";

type Session =
  | { state: "checking" }
  | { state: "unreachable" }
  | { state: "signed-out"; expired: boolean }
  /** `required` is false when the server has no ADMIN_PASSWORD. */
  | { state: "signed-in"; required: boolean };

export default function App() {
  const [session, setSession] = useState<Session>({ state: "checking" });

  const check = useCallback(() => {
    api
      .session()
      .then((s) =>
        setSession(s.signedIn ? { state: "signed-in", required: s.required } : { state: "signed-out", expired: false }),
      )
      .catch(() => setSession({ state: "unreachable" }));
  }, []);

  useEffect(check, [check]);

  // Any admin call answered 401: the session expired or the password changed.
  useEffect(
    () =>
      onSignedOut(() =>
        setSession((current) => (current.state === "signed-in" ? { state: "signed-out", expired: true } : current)),
      ),
    [],
  );

  const signOut = useCallback(() => {
    void api.logout().finally(() => setSession({ state: "signed-out", expired: false }));
  }, []);

  if (session.state === "signed-in") {
    return <Dashboard passwordRequired={session.required} onSignOut={signOut} />;
  }
  if (session.state === "checking") return <Garden />;
  return (
    <Login
      unreachable={session.state === "unreachable"}
      expired={session.state === "signed-out" && session.expired}
      onRetry={check}
      onSignedIn={() => setSession({ state: "signed-in", required: true })}
    />
  );
}
