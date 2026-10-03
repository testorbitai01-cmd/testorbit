import { describe, expect, it } from 'vitest';
import { FaceMonitor } from './faceMonitor';
import { SpeechActivityDetector, rmsDb, voiceBandRatio } from './speechDetector';

const faceCfg = { faceAbsenceMs: 8000, multipleFacesMs: 3000, cooldownMs: 30000 };

/** Feed one observation per second; returns all events produced. */
function runFaces(monitor: FaceMonitor, counts: number[], startAt = 0, stepMs = 1000) {
  return counts.flatMap((faceCount, i) => monitor.update({ faceCount, maxConfidence: faceCount ? 0.9 : 0, now: startAt + i * stepMs }));
}

describe('FaceMonitor', () => {
  it('reports FACE_NOT_VISIBLE once after the configured absence, not every frame', () => {
    const m = new FaceMonitor(faceCfg);
    const events = runFaces(m, [1, 1, ...Array(20).fill(0)]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'FACE_NOT_VISIBLE', details: { durationMs: 8000 } });
    expect(m.state).toBe('no-face');
  });

  it('ignores short absences (looking down briefly)', () => {
    const m = new FaceMonitor(faceCfg);
    expect(runFaces(m, [1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1])).toEqual([]);
  });

  it('reports MULTIPLE_FACES_DETECTED only when sustained, with face count and confidence', () => {
    const m = new FaceMonitor(faceCfg);
    expect(runFaces(m, [1, 2, 1, 1, 1, 1, 1])).toEqual([]); // one stray frame (reflection, poster)
    const m2 = new FaceMonitor(faceCfg);
    const events = runFaces(m2, [1, 2, 2, 3, 2, 2, 2, 2]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'MULTIPLE_FACES_DETECTED', details: { faceCount: 3, confidence: 0.9 } });
  });

  it('is not reset by brief detector flicker (spurious face while away, second face seen intermittently)', () => {
    // Student away; the detector reports a "face" for one frame every few seconds.
    const away = new FaceMonitor(faceCfg);
    const e1 = runFaces(away, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(e1.map((e) => e.type)).toEqual(['FACE_NOT_VISIBLE']);
    // Someone behind the student, detected in roughly every other frame.
    const crowd = new FaceMonitor(faceCfg);
    expect(runFaces(crowd, [1, 2, 1, 2, 2, 1, 2, 1]).map((e) => e.type)).toEqual(['MULTIPLE_FACES_DETECTED']);
  });

  it('applies a per-type cooldown across repeated episodes', () => {
    const m = new FaceMonitor(faceCfg);
    // Episode 1 (absent 10 s), back, episode 2 within cooldown, back, episode 3 after cooldown.
    const seq = [...Array(10).fill(0), 1, ...Array(10).fill(0), 1, ...Array(20).fill(1), ...Array(10).fill(0)];
    const events = runFaces(m, seq);
    expect(events.map((e) => e.type)).toEqual(['FACE_NOT_VISIBLE', 'FACE_NOT_VISIBLE']);
  });
});

const speechCfg = { minSpeechMs: 2500, noiseMarginDb: 12, minLevelDb: -50, bandRatio: 0.55, cooldownMs: 30000 };
const QUIET = { levelDb: -65, voiceBandRatio: 0.3 };
const VOICE = { levelDb: -30, voiceBandRatio: 0.8 };

/** Feed frames every 100 ms. */
function runSpeech(d: SpeechActivityDetector, frames: { levelDb: number; voiceBandRatio: number }[], startAt = 0) {
  return frames.flatMap((f, i) => {
    const ev = d.process(f, startAt + i * 100);
    return ev ? [{ ...ev, at: startAt + i * 100 }] : [];
  });
}
const repeat = <T,>(x: T, n: number) => Array<T>(n).fill(x);

describe('SpeechActivityDetector', () => {
  it('detects sustained speech once, after the configured duration', () => {
    const d = new SpeechActivityDetector(speechCfg);
    const events = runSpeech(d, [...repeat(QUIET, 30), ...repeat(VOICE, 60)]);
    expect(events).toHaveLength(1);
    expect(events[0]!.at).toBe(3000 + 2500);
    expect(events[0]!.details.durationMs).toBe(2500);
  });

  it('bridges short pauses between words but not long silences', () => {
    const d = new SpeechActivityDetector(speechCfg);
    // 0.6 s voice / 0.3 s pause ×4 → talking with natural pauses for 3.6 s
    const talk = Array.from({ length: 4 }, () => [...repeat(VOICE, 6), ...repeat(QUIET, 3)]).flat();
    expect(runSpeech(d, [...repeat(QUIET, 20), ...talk])).toHaveLength(1);
    const d2 = new SpeechActivityDetector(speechCfg);
    // 1 s bursts separated by 1 s silence never reach 2.5 s continuous activity
    const bursts = Array.from({ length: 5 }, () => [...repeat(VOICE, 10), ...repeat(QUIET, 10)]).flat();
    expect(runSpeech(d2, [...repeat(QUIET, 20), ...bursts])).toHaveLength(0);
  });

  it('ignores loud non-voice noise and quiet background chatter', () => {
    const d = new SpeechActivityDetector(speechCfg);
    // fan / hum: loud but energy outside the voice band
    expect(runSpeech(d, [...repeat(QUIET, 20), ...repeat({ levelDb: -25, voiceBandRatio: 0.2 }, 100)])).toHaveLength(0);
    // distant voices: voice-like but below the absolute minimum level
    const d2 = new SpeechActivityDetector(speechCfg);
    expect(runSpeech(d2, [...repeat({ levelDb: -80, voiceBandRatio: 0.3 }, 20), ...repeat({ levelDb: -58, voiceBandRatio: 0.8 }, 100)])).toHaveLength(0);
  });

  it('adapts to a persistently louder room so steady noise stops counting', () => {
    const d = new SpeechActivityDetector(speechCfg);
    const steady = { levelDb: -36, voiceBandRatio: 0.7 }; // e.g. constant crowd murmur
    const events = runSpeech(d, [...repeat(QUIET, 20), ...repeat(steady, 900)]); // 90 s
    expect(events.length).toBeLessThanOrEqual(1);
    expect(d.noiseFloorDb!).toBeGreaterThan(-50);
    expect(d.speaking).toBe(false);
  });

  it('reports 40 s of continuous speech as a single event', () => {
    const d = new SpeechActivityDetector(speechCfg);
    expect(runSpeech(d, [...repeat(QUIET, 20), ...repeat(VOICE, 400)])).toHaveLength(1);
  });

  it('applies the cooldown between separate speech episodes', () => {
    const d = new SpeechActivityDetector(speechCfg);
    // event at 4.5 s; 2nd episode starts at 10 s (inside the 30 s cooldown); 3rd starts at 44 s (after it).
    const frames = [...repeat(QUIET, 20), ...repeat(VOICE, 60), ...repeat(QUIET, 20), ...repeat(VOICE, 60), ...repeat(QUIET, 280), ...repeat(VOICE, 60)];
    const events = runSpeech(d, frames);
    expect(events.map((e) => e.at)).toEqual([4500, 46500]);
  });

  it('computes level and voice-band features from raw analyser data', () => {
    expect(rmsDb(new Float32Array(512))).toBe(-100);
    const sine = Float32Array.from({ length: 512 }, (_, i) => 0.5 * Math.sin(i / 3));
    expect(rmsDb(sine)).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 0);
    const sr = 48000;
    const bins = 512;
    const voiceOnly = Float32Array.from({ length: bins }, (_, i) => ((i * sr) / 2 / bins >= 300 && (i * sr) / 2 / bins <= 3400 ? -30 : -140));
    expect(voiceBandRatio(voiceOnly, sr)).toBeGreaterThan(0.99);
    const lowRumble = Float32Array.from({ length: bins }, (_, i) => ((i * sr) / 2 / bins < 250 ? -20 : -140));
    expect(voiceBandRatio(lowRumble, sr)).toBeLessThan(0.01);
  });
});
