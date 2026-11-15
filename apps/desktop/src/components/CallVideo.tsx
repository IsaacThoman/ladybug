import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { FULL_FRAME, detectCrop, fitAspect, sameCrop } from "../calls/crop";
import type { Crop } from "../calls/crop";

/** How often to look for black bars, and how big a frame to look at. */
const SAMPLE_MS = 500;
const SAMPLE_PX = 160;
/** Until the first frame arrives. */
const FALLBACK_ASPECT = 3 / 4;

type View = { crop: Crop; videoWidth: number; videoHeight: number };

/**
 * The caller's video, cropped to the picture: the call bridge pads a phone's
 * feed with black bars (above and below, or left and right), which are found
 * by sampling frames and cut off. Sized as large as fits the given box.
 */
export default function CallVideo({ id, videoRef, active, maxWidth, maxHeight }: {
  id: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  active: boolean;
  maxWidth: number;
  maxHeight: number;
}) {
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!active || !video) return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    let current: Crop | null = null;
    // A changed crop has to show up twice in a row, so one odd frame can't make it jump.
    let pending: Crop | null = null;
    const sample = () => {
      const { videoWidth, videoHeight } = video;
      if (!context || !videoWidth || !videoHeight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const scale = Math.min(1, SAMPLE_PX / Math.max(videoWidth, videoHeight));
      canvas.width = Math.max(1, Math.round(videoWidth * scale));
      canvas.height = Math.max(1, Math.round(videoHeight * scale));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const found = detectCrop(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      let next = current ?? FULL_FRAME;
      if (found && !current) next = found;
      else if (found && !sameCrop(found, next)) {
        if (pending && sameCrop(found, pending)) next = found;
        else pending = found;
      }
      if (next !== current) pending = null;
      current = next;
      setView((prev) =>
        prev && prev.crop === next && prev.videoWidth === videoWidth && prev.videoHeight === videoHeight
          ? prev
          : { crop: next, videoWidth, videoHeight },
      );
    };
    sample();
    const interval = setInterval(sample, SAMPLE_MS);
    video.addEventListener("resize", sample);
    return () => {
      clearInterval(interval);
      video.removeEventListener("resize", sample);
      setView(null);
    };
  }, [active, videoRef]);

  const crop = view?.crop ?? FULL_FRAME;
  const aspect = view
    ? (view.videoWidth * crop.width) / (view.videoHeight * crop.height)
    : FALLBACK_ASPECT;
  const size = fitAspect(aspect, maxWidth, maxHeight);

  return (
    <div className="pet-call-video" hidden={!active} style={size}>
      <video
        id={id}
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: `${100 / crop.width}%`,
          height: `${100 / crop.height}%`,
          left: `${(-crop.x / crop.width) * 100}%`,
          top: `${(-crop.y / crop.height) * 100}%`,
        }}
      />
    </div>
  );
}
