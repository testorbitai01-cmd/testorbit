/**
 * Camera / microphone access.
 *
 * PRIVACY: streams obtained here are used ONLY for the local preview and the
 * local microphone level meter. They are never recorded, streamed or uploaded.
 * The only image that ever leaves the browser is the single identity photo the
 * student explicitly confirms on the device-check page.
 *
 * The stream is kept in this module so it survives client-side navigation
 * (device check → instructions → assessment) without re-prompting.
 */

export type DeviceStatus = 'idle' | 'requesting' | 'ok' | 'denied' | 'missing' | 'busy' | 'error';

let videoStream: MediaStream | null = null;
let audioStream: MediaStream | null = null;

export function mediaSupport(): { ok: true } | { ok: false; reason: string } {
  if (typeof window === 'undefined') return { ok: false, reason: 'Not running in a browser' };
  if (!window.isSecureContext) {
    return { ok: false, reason: 'Camera and microphone require a secure (HTTPS) connection. Please open the portal using its https:// address.' };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: 'This browser does not support camera/microphone access. Please use the latest Chrome, Edge or Firefox on a desktop or laptop.' };
  }
  return { ok: true };
}

export function statusFromError(err: unknown): DeviceStatus {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'error';
}

export const DEVICE_MESSAGES: Record<DeviceStatus, string> = {
  idle: 'Not checked yet',
  requesting: 'Waiting for permission…',
  ok: 'Working',
  denied: 'Permission was blocked. Click the camera icon in the address bar, choose “Allow”, then press Retry.',
  missing: 'No device was found. Connect a camera/microphone and press Retry.',
  busy: 'The device is being used by another application. Close other apps (Zoom, Teams, etc.) and press Retry.',
  error: 'The device could not be started. Press Retry, or try another browser.',
};

const live = (s: MediaStream | null) => Boolean(s && s.getTracks().length > 0 && s.getTracks().every((t) => t.readyState === 'live'));

export async function acquireCamera(): Promise<MediaStream> {
  if (live(videoStream)) return videoStream!;
  videoStream?.getTracks().forEach((t) => t.stop());
  videoStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    audio: false,
  });
  return videoStream;
}

export async function acquireMicrophone(): Promise<MediaStream> {
  if (live(audioStream)) return audioStream!;
  audioStream?.getTracks().forEach((t) => t.stop());
  audioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  return audioStream;
}

export function currentStreams() {
  return { video: live(videoStream) ? videoStream : null, audio: live(audioStream) ? audioStream : null };
}

export function releaseMedia() {
  videoStream?.getTracks().forEach((t) => t.stop());
  audioStream?.getTracks().forEach((t) => t.stop());
  videoStream = null;
  audioStream = null;
}

/** Grab one still frame from a playing <video> as a JPEG blob (max 640px wide). */
export async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  const w = Math.min(640, video.videoWidth || 640);
  const h = Math.round((w / (video.videoWidth || 640)) * (video.videoHeight || 480));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not supported');
  ctx.drawImage(video, 0, 0, w, h);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not capture photo'))), 'image/jpeg', 0.85));
}

/** Start a <video> preview; tolerates browsers/environments where play() returns nothing or rejects. */
export function safePlay(video: HTMLVideoElement | null | undefined): void {
  try {
    const p = video?.play() as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
  } catch {
    /* autoplay blocked or not supported — the stream still feeds detection when it starts */
  }
}
