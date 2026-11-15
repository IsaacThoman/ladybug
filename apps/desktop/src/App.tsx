import { useEffect, useState } from "react";
import Account from "./components/Account";
import FaceTime from "./components/FaceTime";
import { useOverlayPointer } from "./overlay-pointer";
import { SERVER_URL } from "./api";
import type { OverlayLayout } from "./ladybug-api";
import { useSession } from "./session";

export default function App() {
  useOverlayPointer();
  const [layout, setLayout] = useState<OverlayLayout | null>(null);
  const session = useSession();
  // The panel opens by itself until the account is approved, unless waved away.
  const [dismissed, setDismissed] = useState(false);
  const [requested, setRequested] = useState(false);
  const showAccount = requested || (!dismissed && session?.account.status !== "approved");

  useEffect(() => {
    window.ladybug.getLayout().then(setLayout);
    return window.ladybug.onLayoutChanged(setLayout);
  }, []);

  useEffect(() => window.ladybug.onAccountRequested(() => setRequested(true)), []);

  // Support calls run in the main process, as whoever is signed in here.
  const token = session?.token ?? null;
  useEffect(() => window.ladybug.setCallSession(token ? { url: SERVER_URL, token } : null), [token]);

  if (!layout) return null;
  return (
    <>
      <FaceTime layout={layout} onAccountNeeded={() => setRequested(true)} />
      {showAccount && (
        <Account
          layout={layout}
          session={session}
          onClose={() => {
            setRequested(false);
            setDismissed(true);
          }}
        />
      )}
    </>
  );
}
