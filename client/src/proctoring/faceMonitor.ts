/**
 * Turns per-frame face counts into debounced, reportable events (pure logic —
 * no camera access, fully deterministic for tests).
 *
 *  • FACE_NOT_VISIBLE        — no face for `faceAbsenceMs` continuously
 *  • MULTIPLE_FACES_DETECTED — ≥ 2 faces for `multipleFacesMs` continuously
 *
 * An episode survives brief interruptions shorter than `graceMs` (a single
 * spurious detection, a second face that is only detected in some frames), so
 * flickering detector output neither hides nor duplicates a condition.
 * Each condition is reported at most once per episode, and never more often
 * than `cooldownMs` per type, so a person standing behind the student for a
 * minute produces one event, not sixty.
 */
export type FaceEventType = 'FACE_NOT_VISIBLE' | 'MULTIPLE_FACES_DETECTED';

export interface FaceMonitorConfig {
  faceAbsenceMs: number;
  multipleFacesMs: number;
  cooldownMs: number;
  /** An episode ends only after its condition has been absent this long (default 1500 ms). */
  graceMs?: number;
}

export interface FaceObservation {
  /** Faces at or above the confidence threshold in this frame. */
  faceCount: number;
  /** Highest face confidence in the frame (0 when none). */
  maxConfidence: number;
  now: number;
}

export interface FaceEvent {
  type: FaceEventType;
  /** Metadata only. */
  details: { durationMs: number; faceCount?: number; confidence?: number };
}

export type FaceState = 'unknown' | 'ok' | 'no-face' | 'multiple';

interface Episode {
  since: number;
  lastSeen: number;
  reported: boolean;
  peakFaces: number;
  peakConfidence: number;
}

export class FaceMonitor {
  private absent: Episode | null = null;
  private multiple: Episode | null = null;
  private lastReported: Partial<Record<FaceEventType, number>> = {};
  state: FaceState = 'unknown';

  constructor(private cfg: FaceMonitorConfig) {}

  update(o: FaceObservation): FaceEvent[] {
    const events: FaceEvent[] = [];
    this.state = o.faceCount === 0 ? 'no-face' : o.faceCount > 1 ? 'multiple' : 'ok';

    const grace = this.cfg.graceMs ?? 1500;
    const track = (ep: Episode | null, present: boolean): Episode | null => {
      if (present) {
        const e = ep ?? { since: o.now, lastSeen: o.now, reported: false, peakFaces: 0, peakConfidence: 0 };
        e.lastSeen = o.now;
        return e;
      }
      return ep && o.now - ep.lastSeen <= grace ? ep : null;
    };
    this.absent = track(this.absent, o.faceCount === 0);
    this.multiple = track(this.multiple, o.faceCount >= 2);
    if (this.multiple && o.faceCount >= 2) {
      this.multiple.peakFaces = Math.max(this.multiple.peakFaces, o.faceCount);
      this.multiple.peakConfidence = Math.max(this.multiple.peakConfidence, o.maxConfidence);
    }

    const check = (ep: Episode | null, type: FaceEventType, thresholdMs: number) => {
      // Only report while the condition is currently present (not during the grace tail).
      if (!ep || ep.reported || ep.lastSeen !== o.now || o.now - ep.since < thresholdMs) return;
      const last = this.lastReported[type];
      if (last !== undefined && o.now - last < this.cfg.cooldownMs) return;
      ep.reported = true;
      this.lastReported[type] = o.now;
      const durationMs = Math.round(o.now - ep.since);
      events.push({
        type,
        details:
          type === 'MULTIPLE_FACES_DETECTED'
            ? { durationMs, faceCount: ep.peakFaces, confidence: Math.round(ep.peakConfidence * 100) / 100 }
            : { durationMs },
      });
    };
    check(this.absent, 'FACE_NOT_VISIBLE', this.cfg.faceAbsenceMs);
    check(this.multiple, 'MULTIPLE_FACES_DETECTED', this.cfg.multipleFacesMs);
    return events;
  }

  reset() {
    this.absent = null;
    this.multiple = null;
    this.state = 'unknown';
  }
}
