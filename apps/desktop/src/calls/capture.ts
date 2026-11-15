export type CaptureStatus = { sharing: boolean; cameraUnavailable: boolean };
export const CAMERA_UNAVAILABLE = "Camera unavailable; sharing screen only.";

/** Screen-sized output with a cropped camera inset in the bottom-right corner. */
export function compositionGeometry(width: number, height: number) {
  const scale = Math.min(1, 1920 / width, 1080 / height);
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  const insetWidth = w * 0.22;
  const insetHeight = Math.min(insetWidth * 0.75, h * 0.3);
  const margin = Math.min(w, h) * 0.025;
  return { width: w, height: h, inset: { x: w - insetWidth - margin, y: h - insetHeight - margin, width: insetWidth, height: insetHeight } };
}

export function cropCamera(width: number, height: number, targetWidth: number, targetHeight: number) {
  const scale = Math.max(targetWidth / width, targetHeight / height);
  const w = targetWidth / scale, h = targetHeight / scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

/** Owns all original and composite tracks, including acquisitions that finish after stop. */
export function createCapture(ended: () => void, status: (state: CaptureStatus) => void) {
  const abort = new AbortController();
  const streams = new Set<MediaStream>();
  const elements: HTMLVideoElement[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let camera: HTMLVideoElement | undefined;
  let cameraStream: MediaStream | undefined;
  let cameraDeadline = 0;
  let cameraUnavailable = false;
  let sharing = false;
  const report = () => status({ sharing, cameraUnavailable });
  const stop = () => {
    if (abort.signal.aborted) return;
    abort.abort();
    clearInterval(timer);
    for (const stream of streams) stream.getTracks().forEach((t) => t.stop());
    streams.clear();
    for (const element of elements) { element.pause(); element.srcObject = null; element.remove(); }
    sharing = false; report();
  };
  const pending = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const canceled = () => reject(new Error("Screen sharing was canceled."));
    if (abort.signal.aborted) canceled();
    abort.signal.addEventListener("abort", canceled, { once: true });
    promise.then(resolve, reject).finally(() => abort.signal.removeEventListener("abort", canceled));
  });
  const own = (stream: MediaStream) => {
    if (abort.signal.aborted) { stream.getTracks().forEach((t) => t.stop()); throw new Error("Screen sharing was canceled."); }
    streams.add(stream);
    return stream;
  };
  const acquire = (constraints: MediaStreamConstraints) => {
    if (abort.signal.aborted) return Promise.reject(new Error("Screen sharing was canceled."));
    return pending(navigator.mediaDevices.getUserMedia(constraints).then(own));
  };
  const attach = (stream: MediaStream) => {
    const element = document.createElement("video");
    element.muted = true; element.playsInline = true; element.srcObject = stream;
    elements.push(element);
    return element;
  };
  const cameraLost = () => {
    cameraUnavailable = true;
    if (camera) { camera.pause(); camera.srcObject = null; }
    camera = undefined;
    cameraStream?.getTracks().forEach((t) => t.stop());
    report();
  };
  const required = (stream: MediaStream, kind: "audio" | "video") => {
    const track = stream.getTracks().find((t) => t.kind === kind && t.readyState === "live");
    if (!track) throw new Error(`No live ${kind} track was returned.`);
    track.addEventListener("ended", () => { if (!abort.signal.aborted) { stop(); ended(); } }, { once: true });
    return track;
  };
  return {
    stop,
    async start(callId: string): Promise<{ microphone: MediaStream; composite: MediaStream }> {
      try {
        let screenStream: MediaStream;
        let platform: string | undefined;
        try {
          const source = await pending(window.ladybug.getCallCaptureSource(callId));
          platform = source.platform;
          screenStream = await acquire({ audio: false, video: {
            mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: source.id, maxFrameRate: 15 },
          } as MediaTrackConstraints });
          required(screenStream, "video");
        } catch (error) {
          const guidance = platform === "darwin"
            ? "Enable Ladybugg in macOS System Settings → Privacy & Security → Screen Recording, then try again."
            : platform === "linux"
              ? "Approve screen access in the Wayland/PipeWire portal and check that PipeWire and a compatible desktop portal are running, then try again."
              : platform === "win32"
                ? "Allow screen capture and check that your display is available, then try again."
                : "Approve screen access in the Wayland/PipeWire portal, or enable Ladybugg in macOS System Settings → Privacy & Security → Screen Recording, then try again.";
          throw new Error(`Screen sharing could not start. ${guidance}`, { cause: error });
        }
        sharing = true; report();
        let microphone: MediaStream;
        try { microphone = await acquire({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); required(microphone, "audio"); }
        catch (error) { throw new Error("Microphone unavailable or permission denied. Connect a microphone and allow microphone access in system privacy settings, then try again.", { cause: error }); }
        try {
          const stream = await acquire({ audio: false, video: true });
          const track = stream.getVideoTracks()[0];
          if (!track || track.readyState !== "live") throw new Error("Camera unavailable");
          cameraStream = stream;
          cameraDeadline = Date.now() + 5000;
          camera = attach(stream);
          track.addEventListener("ended", cameraLost, { once: true });
          void camera.play().catch(() => { if (!abort.signal.aborted) cameraLost(); });
        } catch (error) { if (abort.signal.aborted) throw error; cameraLost(); }
        const screen = attach(screenStream);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Could not compose the screen video.");
        // Timer rendering continues in a hidden overlay (backgroundThrottling is disabled).
        await pending(new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 15_000;
          let drawn = false;
          void screen.play().catch(reject);
          timer = setInterval(() => {
            if (screen.readyState < 2 || !screen.videoWidth || !screen.videoHeight) {
              if (!drawn && Date.now() > deadline) reject(new Error("Screen sharing produced no video. Check screen recording permissions and your PipeWire portal, then try again."));
              return;
            }
            try {
              let cameraReady = !!camera && camera.readyState >= 2 && !!camera.videoWidth && !!camera.videoHeight;
              if (camera && !cameraReady && Date.now() > cameraDeadline) { cameraLost(); cameraReady = false; }
              const geometry = compositionGeometry(screen.videoWidth, screen.videoHeight);
              if (canvas.width !== geometry.width || canvas.height !== geometry.height) { canvas.width = geometry.width; canvas.height = geometry.height; }
              context.drawImage(screen, 0, 0, canvas.width, canvas.height);
              if (camera && cameraReady) {
                const inset = geometry.inset;
                const crop = cropCamera(camera.videoWidth, camera.videoHeight, inset.width, inset.height);
                context.drawImage(camera, crop.x, crop.y, crop.width, crop.height, inset.x, inset.y, inset.width, inset.height);
              }
              if (!drawn) { drawn = true; resolve(); }
            } catch (error) { if (!drawn) reject(error); else { stop(); ended(); } }
          }, 1000 / 15);
        }));
        const composite = own(canvas.captureStream(15));
        required(composite, "video");
        return { microphone, composite };
      } catch (error) { stop(); throw error; }
    },
  };
}
