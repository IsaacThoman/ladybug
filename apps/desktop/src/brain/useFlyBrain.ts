import { useEffect, useState } from "react";
import type { BrainSettings } from "../ladybug-api";
import { BrainClient } from "./client";
import { FlyBrain } from "./fly-brain";
import { createBrainWorker } from "./worker";

const OFF: BrainSettings = { enabled: false, showActivity: false };

/**
 * The fly brain, started and stopped with its setting in the tray menu. The
 * pet drives it from its animation loop; see FlyBrain.
 */
export function useFlyBrain(behavior: ConstructorParameters<typeof FlyBrain>[1]) {
  const [brain] = useState(() => new FlyBrain(
    new BrainClient({ createWorker: createBrainWorker, loadData: () => window.ladybug.brain.getData() }),
    behavior,
  ));
  const [settings, setSettings] = useState(OFF);

  useEffect(() => {
    let live = true;
    window.ladybug.brain.getSettings().then((next) => { if (live) setSettings(next); }, () => {});
    const unsubscribe = window.ladybug.brain.onSettingsChanged(setSettings);
    return () => { live = false; unsubscribe(); };
  }, []);

  // Turning it off and on again also retries a brain that failed.
  useEffect(() => {
    if (!settings.enabled) return;
    brain.client.start();
    const unsubscribe = window.ladybug.brain.onCursor((point) => brain.setCursor(point));
    return () => {
      unsubscribe();
      brain.setCursor(null);
      brain.client.stop();
    };
  }, [brain, settings.enabled]);

  return { brain, showActivity: settings.enabled && settings.showActivity };
}
