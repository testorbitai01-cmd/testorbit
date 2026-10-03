/**
 * Speech-ACTIVITY detection (pure logic, deterministic for tests).
 *
 * It answers only "does this sound like sustained talking?" — it never
 * identifies the speaker or what is said, and nothing is recorded.
 *
 * Per ~100 ms frame we compute two features from the Web Audio analyser:
 *   • level (dBFS, time-domain RMS)
 *   • voice-band ratio: share of spectral energy in ≈300–3400 Hz
 * A frame is "voiced" when it is louder than an adaptive background-noise
 * floor by `noiseMarginDb`, above an absolute minimum, and dominated by the
 * voice band. Steady noise (fans, hum) is absorbed into the floor over time;
 * short clicks and bangs are ignored because speech must persist for
 * `minSpeechMs` with at least half of the frames voiced (short pauses between
 * words are bridged by a hangover). Each speech episode is reported once,
 * and at most once per `cooldownMs`.
 *
 * Limitations: background conversation, TV/radio, or the student reading
 * aloud quietly can all trigger it; very soft whispering may not. Thresholds
 * are configurable and must be tuned under real lab conditions.
 */
export interface SpeechConfig {
  minSpeechMs: number;
  noiseMarginDb: number;
  minLevelDb: number;
  bandRatio: number;
  cooldownMs: number;
  /** Silence shorter than this does not end a speech episode (pauses between words). */
  hangoverMs?: number;
}

export interface AudioFrameFeatures {
  levelDb: number;
  voiceBandRatio: number;
}

export interface SpeechEvent {
  type: 'SPEECH_DETECTED';
  details: { durationMs: number; levelDb: number; voicedRatio: number };
}

const SILENCE_DB = -100;

/** RMS level of a time-domain frame in dBFS. */
export function rmsDb(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
}

/** Share of power in the voice band, from an analyser's dB spectrum. */
export function voiceBandRatio(spectrumDb: Float32Array, sampleRate: number, lowHz = 300, highHz = 3400): number {
  const binHz = sampleRate / 2 / spectrumDb.length;
  let total = 0;
  let band = 0;
  for (let i = 1; i < spectrumDb.length; i++) {
    const hz = i * binHz;
    if (hz < 80 || hz > 8000) continue; // ignore DC rumble and hiss
    const p = Math.pow(10, (spectrumDb[i] ?? -Infinity) / 10);
    if (!Number.isFinite(p)) continue;
    total += p;
    if (hz >= lowHz && hz <= highHz) band += p;
  }
  return total > 0 ? band / total : 0;
}

export class SpeechActivityDetector {
  private floorDb: number | null = null;
  private segStart: number | null = null;
  private lastVoiced = 0;
  private segFrames = 0;
  private segVoiced = 0;
  private segPeakDb = SILENCE_DB;
  private reported = false;
  private lastEventAt: number | null = null;
  speaking = false;

  constructor(private cfg: SpeechConfig) {}

  get noiseFloorDb() {
    return this.floorDb;
  }

  process(f: AudioFrameFeatures, now: number): SpeechEvent | null {
    const hangover = this.cfg.hangoverMs ?? 450;
    if (this.floorDb === null) this.floorDb = f.levelDb;
    const voiced = f.levelDb >= this.cfg.minLevelDb && f.levelDb >= this.floorDb + this.cfg.noiseMarginDb && f.voiceBandRatio >= this.cfg.bandRatio;

    // Adaptive noise floor: falls quickly to quieter levels and rises slowly, so a
    // steady sound is eventually absorbed (≈1–2 min while it still looks like voice,
    // seconds when it does not) but a conversation is not.
    const rate = f.levelDb < this.floorDb ? 0.3 : voiced ? 0.001 : 0.02;
    this.floorDb += (f.levelDb - this.floorDb) * rate;

    if (voiced) {
      if (this.segStart === null) {
        this.segStart = now;
        this.segFrames = 0;
        this.segVoiced = 0;
        this.segPeakDb = SILENCE_DB;
        this.reported = false;
      }
      this.lastVoiced = now;
      this.segVoiced += 1;
      this.segPeakDb = Math.max(this.segPeakDb, f.levelDb);
    } else if (this.segStart !== null && now - this.lastVoiced > hangover) {
      this.segStart = null;
    }
    if (this.segStart !== null) this.segFrames += 1;
    this.speaking = this.segStart !== null;

    if (this.segStart === null || this.reported) return null;
    const duration = now - this.segStart;
    const density = this.segVoiced / Math.max(1, this.segFrames);
    if (duration < this.cfg.minSpeechMs || density < 0.5) return null;
    if (this.lastEventAt !== null && now - this.lastEventAt < this.cfg.cooldownMs) return null;

    this.reported = true;
    this.lastEventAt = now;
    return {
      type: 'SPEECH_DETECTED',
      details: { durationMs: Math.round(duration), levelDb: Math.round(this.segPeakDb), voicedRatio: Math.round(density * 100) / 100 },
    };
  }
}
