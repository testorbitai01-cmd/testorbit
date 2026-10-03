import { useEffect, useRef, useState } from 'react';
import type { MonitoringSettings } from '@test-orbit/shared';
import { SpeechActivityDetector, rmsDb, voiceBandRatio, type SpeechEvent } from './speechDetector';
import type { MonitorStatus } from './useFaceMonitor';

export const SPEECH_FRAME_MS = 100;

/**
 * Live speech-ACTIVITY monitoring with the Web Audio API.
 *
 * PRIVACY: audio samples live only in the analyser's in-memory buffers and are
 * overwritten every frame. Nothing is recorded (no MediaRecorder), stored,
 * transcribed or uploaded — only event metadata (duration, level).
 */
export function useSpeechMonitor(opts: {
  audioTrack: MediaStreamTrack | null;
  settings: MonitoringSettings | undefined;
  enabled: boolean;
  onEvent: (e: SpeechEvent) => void;
  onUnavailable: (reason: string) => void;
}) {
  const { audioTrack, settings, enabled } = opts;
  const [status, setStatus] = useState<MonitorStatus>(settings?.speechDetectionEnabled === false ? 'disabled' : 'starting');
  const [speaking, setSpeaking] = useState(false);
  const cb = useRef(opts);
  cb.current = opts;
  const unavailableReported = useRef(false);

  useEffect(() => {
    if (!settings || !settings.speechDetectionEnabled) {
      setStatus('disabled');
      return;
    }
    if (!enabled || !audioTrack || audioTrack.readyState !== 'live') return;
    const fail = (reason: string) => {
      setStatus('unavailable');
      if (!unavailableReported.current) {
        unavailableReported.current = true;
        cb.current.onUnavailable(reason.slice(0, 100));
      }
    };
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      fail('Web Audio API is not supported in this browser');
      return;
    }

    let ctx: AudioContext;
    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      ctx = new Ctx();
      source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser); // analysed only — never connected to a recorder or the speakers
    } catch (e) {
      fail(`Microphone monitoring could not start: ${(e as Error).message}`);
      return;
    }

    const detector = new SpeechActivityDetector({
      minSpeechMs: settings.speechMinDurationMs,
      noiseMarginDb: settings.speechNoiseMarginDb,
      minLevelDb: settings.speechMinLevelDb,
      bandRatio: settings.speechBandRatio,
      cooldownMs: settings.eventCooldownSeconds * 1000,
    });
    const time = new Float32Array(analyser.fftSize);
    const spectrum = new Float32Array(analyser.frequencyBinCount);

    // Browsers may start audio contexts suspended until a user gesture.
    const resume = () => void ctx.resume().catch(() => undefined);
    resume();
    window.addEventListener('pointerdown', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });

    setStatus('active');
    const timer = setInterval(() => {
      if (ctx.state !== 'running') return;
      analyser.getFloatTimeDomainData(time);
      analyser.getFloatFrequencyData(spectrum);
      const ev = detector.process({ levelDb: rmsDb(time), voiceBandRatio: voiceBandRatio(spectrum, ctx.sampleRate) }, performance.now());
      setSpeaking(detector.speaking);
      if (ev) cb.current.onEvent(ev);
    }, SPEECH_FRAME_MS);

    return () => {
      clearInterval(timer);
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      void ctx.close().catch(() => undefined);
    };
  }, [enabled, audioTrack, settings]);

  return { status, speaking };
}
