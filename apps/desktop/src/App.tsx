import { useEffect, useState } from "react";
import Account from "./components/Account";
import FaceTime from "./components/FaceTime";
import { useOverlayPointer } from "./overlay-pointer";
import Pet from "./components/Pet";
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

  if (!layout) return null;
  return (
    <>
      <Pet layout={layout} onAccountNeeded={() => setRequested(true)} />
      <FaceTime layout={layout} />
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
