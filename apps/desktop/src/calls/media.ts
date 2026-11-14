import { LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, Track } from "livekit-client";
import type { RemoteParticipant, RemoteTrack, RemoteTrackPublication } from "livekit-client";
import type { PreparedCall } from "./types";
import type { CallMedia } from "./controller";

/** One audio publication stays unmuted; its PCM samples are silent until bridge_ready. */
export function createCallMedia(prepared: PreparedCall, disconnected: () => void,
  video: HTMLVideoElement, audio: HTMLAudioElement, showVideo: (available: boolean) => void,
  playbackBlocked: () => void): CallMedia {
  const room = new Room({ adaptiveStream: false, dynacast: false });
  let stopped = false;
  let active = false;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let gain: GainNode | undefined;
  let localAudio: LocalAudioTrack | undefined;
  let localVideo: LocalVideoTrack | undefined;
  let remoteVideo: RemoteTrack | undefined;
  let remoteAudio: RemoteTrack | undefined;
  const isBridge = (identity: string) => identity === prepared.bridgeIdentity;

  const clearVideo = () => {
    remoteVideo?.detach(video); remoteVideo = undefined;
    video.srcObject = null; showVideo(false);
  };
  const clearAudio = () => {
    remoteAudio?.detach(audio); remoteAudio = undefined; audio.srcObject = null;
  };
  const refresh = () => {
    if (stopped) return;
    const bridge = [...room.remoteParticipants.values()].find((p) => isBridge(p.identity));
    const tracks = [...(bridge?.trackPublications.values() ?? [])];
    const visible = tracks.find((p) => p.kind === Track.Kind.Video && p.isSubscribed && !p.isMuted)?.track;
    const audible = tracks.find((p) => p.kind === Track.Kind.Audio && p.isSubscribed && !p.isMuted)?.track;
    if (visible !== remoteVideo) {
      clearVideo();
      if (visible) { remoteVideo = visible; visible.attach(video); showVideo(true); void video.play().catch(playbackBlocked); }
    }
    if (audible !== remoteAudio) {
      clearAudio();
      if (audible) { remoteAudio = audible; audible.attach(audio); void audio.play().catch(playbackBlocked); }
    }
  };
  room.on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (isBridge(participant.identity)) publication.setSubscribed(true);
  });
  room.on(RoomEvent.TrackSubscribed, refresh);
  room.on(RoomEvent.TrackMuted, refresh);
  room.on(RoomEvent.TrackUnmuted, refresh);
  room.on(RoomEvent.TrackUnsubscribed, refresh);
  room.on(RoomEvent.TrackUnpublished, refresh);
  room.on(RoomEvent.ParticipantDisconnected, refresh);
  room.on(RoomEvent.Disconnected, () => { if (!stopped) disconnected(); });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (gain) gain.gain.value = 0;
    stream?.getTracks().forEach((track) => track.stop());
    localAudio?.stop(); localVideo?.stop();
    if (context) void context.close();
    clearVideo(); clearAudio();
    room.removeAllListeners();
    void room.disconnect();
  };
  return {
    async connect() {
      await room.connect(prepared.url, prepared.token, { autoSubscribe: false });
      if (stopped) { await room.disconnect(); return; }
      for (const participant of room.remoteParticipants.values()) {
        if (isBridge(participant.identity)) {
          participant.trackPublications.forEach((p) => p.setSubscribed(true));
        }
      }
    },
    async publish() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: true });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        context = new AudioContext();
        gain = context.createGain(); gain.gain.value = 0;
        const source = context.createMediaStreamSource(stream);
        const output = context.createMediaStreamDestination();
        source.connect(gain); gain.connect(output);
        await context.resume();
        if (stopped) return;
        if (context.state !== "running") throw new Error("Audio could not start. Try calling again.");
        localAudio = new LocalAudioTrack(output.stream.getAudioTracks()[0], undefined, true);
        localVideo = new LocalVideoTrack(stream.getVideoTracks()[0], undefined, true);
        for (const track of stream.getTracks()) track.addEventListener("ended", () => { if (!stopped) disconnected(); });
        await room.localParticipant.publishTrack(localAudio, { source: Track.Source.Microphone, dtx: false });
        if (stopped) return;
        await room.localParticipant.publishTrack(localVideo, { source: Track.Source.Camera });
        if (stopped) return;
      } catch (error) {
        stop();
        if (error instanceof DOMException && ["NotAllowedError", "PermissionDeniedError"].includes(error.name)) {
          throw new Error("Camera or microphone permission denied. Allow both in system privacy settings, then try again.", { cause: error });
        }
        if (error instanceof DOMException && ["NotFoundError", "NotReadableError"].includes(error.name)) {
          throw new Error("Camera or microphone unavailable. Connect both devices and close apps using them, then try again.", { cause: error });
        }
        throw new Error("Could not connect camera and microphone. Check your devices and LiveKit connection.", { cause: error });
      }
    },
    activate() { if (!stopped && !active && gain) { active = true; gain.gain.value = 1; } },
    stop,
  };
}
