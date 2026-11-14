import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FaceTimeController } from "../calls/controller";
import { createCallMedia } from "../calls/media";
import type { OverlayLayout } from "../ladybug-api";

export default function FaceTime({ layout }: { layout: OverlayLayout }) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [controller] = useState(() => new FaceTimeController(window.ladybug.faceTime, (prepared, disconnected) => {
    const videoElement = document.getElementById("facetime-video");
    const audioElement = document.getElementById("facetime-audio");
    if (!(videoElement instanceof HTMLVideoElement) || !(audioElement instanceof HTMLAudioElement)) {
      throw new Error("FaceTime media panel is not ready.");
    }
    setBlocked(false);
    return createCallMedia(prepared, disconnected, videoElement, audioElement, setHasVideo, () => setBlocked(true));
  }));
  useEffect(() => controller.observe(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const busy = !["idle", "ended", "error"].includes(state.phase);
  return <div className="facetime" data-overlay-interactive style={{ top: layout.workArea.y + 16, right: layout.width - layout.workArea.x - layout.workArea.width + 16, maxHeight: layout.workArea.height - 32 }}>
    <button onClick={() => { void (busy ? controller.end() : controller.start()); }}>
      {busy ? "Hang up" : "facetime"}
    </button>
    {state.phase !== "idle" && <section aria-label="FaceTime call">
      <p role="status">{state.message}</p>
      {busy && !hasVideo && <p>Caller video unavailable</p>}
      {blocked && busy && <button onClick={() => {
        void audio.current?.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
        void video.current?.play().catch(() => setBlocked(true));
      }}>Play caller audio/video</button>}
    </section>}
    <video id="facetime-video" ref={video} autoPlay playsInline className={hasVideo ? "caller-video" : "caller-video hidden"} />
    <audio id="facetime-audio" ref={audio} autoPlay />
  </div>;
}
