import { LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, Track } from "livekit-client";
import type { RemoteParticipant, RemoteTrack, RemoteTrackPublication } from "livekit-client";
import type { PreparedCall } from "./types.ts";
import type { CallMedia } from "./controller.ts";

import { createCapture } from "./capture.ts";
import type { CaptureStatus } from "./capture.ts";

/** One audio publication stays unmuted; its PCM samples are silent until bridge_ready. */
export function createCallMedia(prepared: PreparedCall, disconnected: () => void,
  video: HTMLVideoElement, audio: HTMLAudioElement, showVideo: (available: boolean) => void,
  playbackBlocked: () => void, captureStatus: (status: CaptureStatus) => void,
  dependencies = {
    room: () => new Room({ adaptiveStream: false, dynacast: false }),
    audioContext: () => new AudioContext(),
    audioTrack: (track: MediaStreamTrack) => new LocalAudioTrack(track, undefined, true),
    videoTrack: (track: MediaStreamTrack) => new LocalVideoTrack(track, undefined, true),
  }): CallMedia {
  const room = dependencies.room();
  let stopped = false;
  let active = false;
  const capture = createCapture(disconnected, captureStatus);
  let outputStream: MediaStream | undefined;
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
    capture.stop();
    outputStream?.getTracks().forEach((track) => track.stop());
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
        const { microphone, composite } = await capture.start(prepared.id);
        if (stopped) return;
        context = dependencies.audioContext();
        gain = context.createGain(); gain.gain.value = 0;
        const source = context.createMediaStreamSource(microphone);
        const output = context.createMediaStreamDestination();
        outputStream = output.stream;
        source.connect(gain); gain.connect(output);
        await context.resume();
        if (stopped) return;
        if (context.state !== "running") throw new Error("Audio could not start. Try calling again.");
        localAudio = dependencies.audioTrack(output.stream.getAudioTracks()[0]);
        localVideo = dependencies.videoTrack(composite.getVideoTracks()[0]);
        await room.localParticipant.publishTrack(localAudio, { source: Track.Source.Microphone, dtx: false });
        if (stopped) return;
        await room.localParticipant.publishTrack(localVideo, { source: Track.Source.Camera });
        if (stopped) return;
      } catch (error) {
        stop();
        throw error instanceof Error ? error : new Error("Could not publish screen video and microphone. Check your LiveKit connection.", { cause: error });
      }
    },
    activate() { if (!stopped && !active && gain) { active = true; gain.gain.value = 1; } },
    stop,
  };
}
