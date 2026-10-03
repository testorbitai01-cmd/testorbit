import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MonitoringSettings } from '@test-orbit/shared';
import { FaceMonitor, type FaceEvent, type FaceState } from './faceMonitor';

export type MonitorStatus = 'disabled' | 'starting' | 'active' | 'unavailable';

/** Paths of the self-hosted model and WebAssembly runtime (see client/scripts/copy-mediapipe.mjs). */
export const FACE_MODEL_PATH = '/models/blaze_face_short_range.tflite';
export const MEDIAPIPE_WASM_PATH = '/mediapipe/wasm';

interface Detector {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): { detections: { categories: { score: number }[] }[] };
  close(): void;
}

/** Overridable in tests. Loads MediaPipe lazily so it is a separate chunk downloaded only during an assessment. */
export async function createFaceDetector(minConfidence: number): Promise<Detector> {
  const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_PATH);
  return (await FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_MODEL_PATH, delegate: 'CPU' },
    runningMode: 'VIDEO',
    minDetectionConfidence: minConfidence,
  })) as unknown as Detector;
}

/**
 * Local face monitoring on the live camera preview.
 *
 * PRIVACY: frames are read from the <video> element in memory by the detector
 * and discarded. No frame, screenshot, face crop or embedding is created,
 * stored or sent — only event metadata (type, duration, face count, confidence).
 */
export function useFaceMonitor(opts: {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Changes when the camera stream changes (re-binds the monitor). */
  streamKey: MediaStream | null;
  settings: MonitoringSettings | undefined;
  enabled: boolean;
  onEvent: (e: FaceEvent) => void;
  onUnavailable: (reason: string) => void;
  factory?: (minConfidence: number) => Promise<Detector>;
}) {
  const { videoRef, streamKey, settings, enabled } = opts;
  const [status, setStatus] = useState<MonitorStatus>(settings?.faceDetectionEnabled === false ? 'disabled' : 'starting');
  const [faceState, setFaceState] = useState<FaceState>('unknown');
  const cb = useRef(opts);
  cb.current = opts;
  const unavailableReported = useRef(false);

  useEffect(() => {
    if (!settings || !settings.faceDetectionEnabled) {
      setStatus('disabled');
      return;
    }
    if (!enabled || !streamKey) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let detector: Detector | null = null;
    const monitor = new FaceMonitor({
      faceAbsenceMs: settings.faceAbsenceSeconds * 1000,
      multipleFacesMs: settings.multipleFacesSeconds * 1000,
      cooldownMs: settings.eventCooldownSeconds * 1000,
      graceMs: Math.max(1500, settings.faceDetectionIntervalMs * 2),
    });
    const fail = (reason: string) => {
      if (cancelled) return;
      setStatus('unavailable');
      if (!unavailableReported.current) {
        unavailableReported.current = true;
        cb.current.onUnavailable(reason.slice(0, 100));
      }
    };

    setStatus('starting');
    (cb.current.factory ?? createFaceDetector)(settings.faceMinConfidence)
      .then((d) => {
        if (cancelled) return d.close();
        detector = d;
        setStatus('active');
        let lastTs = 0;
        timer = setInterval(() => {
          const video = videoRef.current;
          if (!detector || !video || video.readyState < 2 || video.videoWidth === 0) return;
          // detectForVideo requires strictly increasing timestamps.
          const ts = Math.max(performance.now(), lastTs + 1);
          lastTs = ts;
          let faces: { score: number }[];
          try {
            faces = detector
              .detectForVideo(video, ts)
              .detections.map((x) => ({ score: x.categories[0]?.score ?? 0 }))
              .filter((f) => f.score >= settings.faceMinConfidence);
          } catch (e) {
            fail(`Face detection error: ${(e as Error).message}`);
            if (timer) clearInterval(timer);
            return;
          }
          const events = monitor.update({ faceCount: faces.length, maxConfidence: Math.max(0, ...faces.map((f) => f.score)), now: performance.now() });
          setFaceState(monitor.state);
          events.forEach((ev) => cb.current.onEvent(ev));
        }, settings.faceDetectionIntervalMs);
      })
      .catch((e: unknown) => fail(`Face detection could not start: ${(e as Error)?.message ?? 'unknown error'}`));

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      detector?.close();
      detector = null;
      monitor.reset();
    };
  }, [enabled, streamKey, settings, videoRef]);

  return { status, faceState };
}
