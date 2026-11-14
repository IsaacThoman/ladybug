import { useEffect, useState } from "react";
import Pet from "./components/Pet";
import type { OverlayLayout } from "./ladybug-api";

export default function App() {
  const [layout, setLayout] = useState<OverlayLayout | null>(null);

  useEffect(() => {
    window.ladybug.getLayout().then(setLayout);
    return window.ladybug.onLayoutChanged(setLayout);
  }, []);

  if (!layout) return null;
  return <Pet layout={layout} />;
}
