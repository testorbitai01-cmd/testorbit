import { z } from 'zod';
import { CLIENT_EVENT_TYPES, DEFAULT_SECTION_KEYS, EVENT_RULE_GROUPS, type ClientEventType, type EventRuleGroup } from '../constants.js';
import { PAPER_DURATION_MAX, PAPER_DURATION_MIN, SECTION_QUESTIONS_MAX } from './paper.js';

/**
 * System-wide policy settings, editable by admins at /admin/settings and
 * stored in the SystemSetting table (validated with this schema on read and write).
 */
export const DEFAULT_EVENT_RULES: Record<ClientEventType, EventRuleGroup> = {
  TAB_HIDDEN: 'TAB_SWITCH',
  WINDOW_BLUR: 'GENERAL',
  CAMERA_DISCONNECTED: 'GENERAL',
  MICROPHONE_DISCONNECTED: 'GENERAL',
  NETWORK_OFFLINE: 'LOG_ONLY',
  NETWORK_RESTORED: 'LOG_ONLY',
  PAGE_UNLOAD: 'LOG_ONLY',
  // Automatic detections can be wrong, so by default they warn but never terminate.
  MULTIPLE_FACES_DETECTED: 'WARN_ONLY',
  FACE_NOT_VISIBLE: 'WARN_ONLY',
  SPEECH_DETECTED: 'WARN_ONLY',
  CAMERA_MONITORING_UNAVAILABLE: 'LOG_ONLY',
  MICROPHONE_MONITORING_UNAVAILABLE: 'LOG_ONLY',
};

/**
 * Local (in-browser) camera and microphone analysis. Frames and audio are
 * processed in memory only; these values tune when a sustained condition
 * becomes a reportable event. Tune them under real lab conditions.
 */
export const monitoringSchema = z.object({
  faceDetectionEnabled: z.boolean().default(true),
  /** How often a camera frame is analysed. */
  faceDetectionIntervalMs: z.coerce.number().int().min(250).max(5000).default(1000),
  /** Minimum detector confidence for a face to count. */
  faceMinConfidence: z.coerce.number().min(0.3).max(0.95).default(0.6),
  /** No face for this long ⇒ FACE_NOT_VISIBLE. */
  faceAbsenceSeconds: z.coerce.number().int().min(2).max(120).default(8),
  /** Two or more faces continuously for this long ⇒ MULTIPLE_FACES_DETECTED. */
  multipleFacesSeconds: z.coerce.number().int().min(1).max(60).default(3),
  speechDetectionEnabled: z.boolean().default(true),
  /** Speech-like audio must persist (allowing short pauses) for this long ⇒ SPEECH_DETECTED. */
  speechMinDurationMs: z.coerce.number().int().min(500).max(15000).default(2500),
  /** How far above the adaptive background-noise floor a frame must be to count as voice. */
  speechNoiseMarginDb: z.coerce.number().min(3).max(40).default(12),
  /** Absolute floor below which audio is always treated as silence. */
  speechMinLevelDb: z.coerce.number().min(-90).max(-10).default(-50),
  /** Minimum share of energy in the voice band (≈300–3400 Hz). */
  speechBandRatio: z.coerce.number().min(0.2).max(0.95).default(0.55),
  /** After an event of a given type, the same type is not reported again for this long (client and server). */
  eventCooldownSeconds: z.coerce.number().int().min(5).max(600).default(30),
});
export type MonitoringSettings = z.output<typeof monitoringSchema>;

/**
 * Values pre-filled in the "New question paper" form. Only future new-paper forms use them;
 * existing papers are never changed. Same limits as a paper's own duration and section counts.
 * Strict numbers (no coercion), so an empty or non-numeric value is rejected, never turned into 0.
 */
const wholeNumber = (label: string, min: number, max: number) =>
  z
    .number({ error: `${label} must be a whole number` })
    .int({ error: `${label} must be a whole number` })
    .min(min, { error: `${label} must be at least ${min}` })
    .max(max, { error: `${label} must be at most ${max}` });

export const INITIAL_PAPER_DEFAULTS = { durationMinutes: 15, sectionCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 } } as const;

export const paperDefaultsSchema = z.object({
  durationMinutes: wholeNumber('Duration', PAPER_DURATION_MIN, PAPER_DURATION_MAX),
  sectionCounts: z.object(
    Object.fromEntries(DEFAULT_SECTION_KEYS.map((k) => [k, wholeNumber(`Section ${k}`, 0, SECTION_QUESTIONS_MAX)])) as Record<
      (typeof DEFAULT_SECTION_KEYS)[number],
      ReturnType<typeof wholeNumber>
    >,
  ),
});
export type PaperDefaults = z.output<typeof paperDefaultsSchema>;

export const settingsSchema = z.object({
  proctoring: z.object({
    /** Tab-switch warnings before the next tab switch terminates the session (default 1 → 2nd switch terminates). */
    tabSwitchMaxWarnings: z.coerce.number().int().min(0).max(10).default(1),
    /** Warnings before the next GENERAL event terminates the session (default 2 → 3rd event terminates). */
    generalMaxWarnings: z.coerce.number().int().min(0).max(10).default(2),
    /** Rule per browser event: TAB_SWITCH / GENERAL (warn, then terminate), WARN_ONLY, or LOG_ONLY. */
    eventRules: z
      .object(
        Object.fromEntries(CLIENT_EVENT_TYPES.map((t) => [t, z.enum(EVENT_RULE_GROUPS).default(DEFAULT_EVENT_RULES[t])])) as Record<
          ClientEventType,
          z.ZodDefault<z.ZodEnum<{ [K in EventRuleGroup]: K }>>
        >,
      )
      .default(DEFAULT_EVENT_RULES),
    /** Same-type events reported within this window are treated as one (debounce). */
    dedupeWindowSeconds: z.coerce.number().int().min(0).max(60).default(3),
    monitoring: monitoringSchema.default(() => monitoringSchema.parse({})),
  }),
  session: z.object({
    /** No heartbeat for this long ⇒ the session is marked INTERRUPTED and needs admin re-entry. */
    heartbeatTimeoutSeconds: z.coerce.number().int().min(60).max(1800).default(180),
    /** Answers arriving this many seconds after the deadline are still accepted (network latency allowance). */
    answerGraceSeconds: z.coerce.number().int().min(0).max(60).default(5),
    /** How long an approved re-entry resume code stays valid. */
    resumeCodeTtlMinutes: z.coerce.number().int().min(5).max(1440).default(60),
  }),
  identityPhoto: z.object({
    required: z.boolean().default(true),
    retentionDays: z.coerce.number().int().min(1).max(3650).default(180),
  }),
  results: z.object({
    /** Show the MCQ score on the student's submission page. Answer keys are never shown to students. */
    showMcqScoreToStudent: z.boolean().default(false),
  }),
  /** Written only through PUT /admin/settings/paper-defaults (the general settings save keeps the stored value). */
  paperDefaults: paperDefaultsSchema.default(() => structuredClone({ ...INITIAL_PAPER_DEFAULTS, sectionCounts: { ...INITIAL_PAPER_DEFAULTS.sectionCounts } })),
});

export type Settings = z.output<typeof settingsSchema>;
export type SettingsInput = z.input<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({
  proctoring: {},
  session: {},
  identityPhoto: {},
  results: {},
});
