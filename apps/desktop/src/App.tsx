import { useEffect, useState } from "react";
import FaceTime from "./components/FaceTime";
import { useOverlayPointer } from "./overlay-pointer";
import Pet from "./components/Pet";
import type { OverlayLayout } from "./ladybug-api";

export default function App() {
  useOverlayPointer();
  const [layout, setLayout] = useState<OverlayLayout | null>(null);

  useEffect(() => {
    window.ladybug.getLayout().then(setLayout);
    return window.ladybug.onLayoutChanged(setLayout);
  }, []);

  if (!layout) return null;
  return <><Pet layout={layout} /><FaceTime layout={layout} /></>;
}
