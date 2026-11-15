import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import CallVideo from "./CallVideo";
import Pet from "./Pet";
import { FaceTimeController } from "../calls/controller";
import type { CaptureStatus } from "../calls/capture";
import { CAMERA_UNAVAILABLE } from "../calls/capture";
import { createCallMedia } from "../calls/media";
import type { OverlayLayout } from "../ladybug-api";
import { getSession } from "../session";

/** "Call ended" goes away by itself; errors wait to be dismissed. */
const ENDED_NOTICE_MS = 5000;
/** The caller's video takes up to this much of the screen. */
const VIDEO_MAX_WIDTH_SHARE = 0.6;
const VIDEO_MAX_HEIGHT_SHARE = 0.72;
/**
 * Room the rest of the call bubble needs around the video: its padding and
 * header, the gap down to the ladybug and the ladybug itself (see Pet).
 */
const BUBBLE_RESERVE = { width: 56, height: 170 };
const VIDEO_ID = "facetime-video";
const AUDIO_ID = "facetime-audio";

export default function FaceTime({ layout, onAccountNeeded }: { layout: OverlayLayout; onAccountNeeded: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureStatus>({ sharing: false, cameraUnavailable: false });
  const [blocked, setBlocked] = useState(false);
  const [controller] = useState(() => new FaceTimeController(window.ladybug.faceTime, (prepared, disconnected) => {
    const videoElement = document.getElementById(VIDEO_ID);
    const audioElement = document.getElementById(AUDIO_ID);
    if (!(videoElement instanceof HTMLVideoElement) || !(audioElement instanceof HTMLAudioElement)) {
      throw new Error("FaceTime media is not ready.");
    }
    setBlocked(false);
    return createCallMedia(prepared, disconnected, videoElement, audioElement, setHasVideo, () => setBlocked(true), setCapture);
  }));
  useEffect(() => controller.observe(), [controller]);
  useEffect(() => window.ladybug.faceTime.onSupportRequest(() => { void controller.start(); }), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const busy = !["idle", "ended", "error"].includes(state.phase);
  const noticeKey = `${state.id}:${state.phase}:${state.message}`;
  const open = state.phase !== "idle" && (busy || dismissed !== noticeKey);

  useEffect(() => {
    if (state.phase !== "ended") return;
    const timeout = setTimeout(() => setDismissed(noticeKey), ENDED_NOTICE_MS);
    return () => clearTimeout(timeout);
  }, [state.phase, noticeKey]);

  const { workArea } = layout;
  const showVideo = busy && hasVideo;
  const content = <>
    <div className="pet-call-header">
      <p role="status" className="pet-call-status" data-phase={state.phase}>{state.message}</p>
      <div className="pet-bubble-actions">
        {busy
          ? <button type="button" className="primary" onClick={() => { void controller.end(); }}>Hang up</button>
          : <button type="button" className="ghost" onClick={() => setDismissed(noticeKey)}>Dismiss</button>}
      </div>
    </div>
    {busy && capture.sharing && <p role="status" className="pet-call-note">Sharing your screen</p>}
    {busy && capture.sharing && capture.cameraUnavailable && <p className="pet-call-note">{CAMERA_UNAVAILABLE}</p>}
    {busy && state.phase === "active" && !hasVideo && <p className="pet-call-note">Caller video unavailable</p>}
    {blocked && busy && <div className="pet-bubble-actions">
      <button type="button" className="ghost" onClick={() => {
        void audio.current?.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
        void video.current?.play().catch(() => setBlocked(true));
      }}>Play caller audio/video</button>
    </div>}
    <CallVideo
      id={VIDEO_ID}
      videoRef={video}
      active={showVideo}
      maxWidth={Math.min(workArea.width * VIDEO_MAX_WIDTH_SHARE, workArea.width - BUBBLE_RESERVE.width)}
      maxHeight={Math.min(workArea.height * VIDEO_MAX_HEIGHT_SHARE, workArea.height - BUBBLE_RESERVE.height)}
    />
  </>;

  return <>
    <Pet layout={layout} onAccountNeeded={onAccountNeeded} callBusy={busy} call={{ open, content }} requestHelp={() => {
      if (getSession()?.account.status !== "approved") { onAccountNeeded(); return; }
      void controller.start();
    }} />
    <audio id={AUDIO_ID} ref={audio} autoPlay />
  </>;
}
