/**
 * Constants shared by the client and the server.
 */

/**
 * The domains created on first install (prisma/seed.ts). After that, domains live
 * only in the database and are managed in Admin → Domains — never rely on this
 * list for what exists.
 */
export const DOMAINS = [
  { slug: 'ai-ml', name: 'AI/ML' },
  { slug: 'data-analytics', name: 'Data Analytics' },
  { slug: 'full-stack-java', name: 'Full Stack - Java' },
  { slug: 'full-stack-python', name: 'Full Stack - Python' },
] as const;

/** URL-safe domain identifier, e.g. "full-stack-java". */
export const DOMAIN_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Lower-case, hyphenated slug for a domain name ("Cloud & DevOps" → "cloud-devops"). */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/**
 * Section identifiers. A paper can have any number of sections (up to
 * MAX_PAPER_SECTIONS); each one draws from the domain's questions tagged with
 * the same key. New papers start with the five default sections A–E.
 */
export type SectionKey = string;
export const DEFAULT_SECTION_KEYS = ['A', 'B', 'C', 'D', 'E'] as const;
export const SECTION_KEY_PATTERN = /^[A-Z0-9]{1,8}$/;
export const MAX_PAPER_SECTIONS = 50;

/** Next unused key in spreadsheet order: A…Z, AA, AB, … */
export function nextSectionKey(existing: readonly string[]): SectionKey {
  const used = new Set(existing.map((k) => k.toUpperCase()));
  for (let n = 1; ; n++) {
    let key = '';
    for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) key = String.fromCharCode(65 + ((x - 1) % 26)) + key;
    if (!used.has(key)) return key;
  }
}

export const QUESTION_TYPES = ['MCQ', 'CODING'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const GRADE_TYPES = ['PERCENTAGE', 'CGPA_10', 'CGPA_4', 'GPA_5'] as const;
export type GradeType = (typeof GRADE_TYPES)[number];

export const GRADE_TYPE_LABELS: Record<GradeType, string> = {
  PERCENTAGE: 'Percentage (0–100)',
  CGPA_10: 'CGPA (out of 10)',
  CGPA_4: 'GPA (out of 4)',
  GPA_5: 'GPA (out of 5)',
};

export const GRADE_TYPE_MAX: Record<GradeType, number> = {
  PERCENTAGE: 100,
  CGPA_10: 10,
  CGPA_4: 4,
  GPA_5: 5,
};

export const EDUCATION_LEVELS = ['SSC', 'HSC', 'UG', 'PG'] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

export const EDUCATION_LEVEL_LABELS: Record<EducationLevel, string> = {
  SSC: '10th Standard',
  HSC: '12th Standard',
  UG: 'Undergraduate Degree',
  PG: 'Postgraduate Degree',
};

/**
 * Assessment session lifecycle (enforced on the server):
 *
 *   CREATED ─► IN_PROGRESS ─┬─► SUBMITTED            (student submits)
 *                           ├─► EXPIRED              (server deadline passed)
 *                           ├─► INTERRUPTED ─┐       (heartbeat lost)
 *                           └─► FLAGGED_FOR_REVIEW ┐ (policy violation; "terminated" for the student)
 *                                            │     │
 *        INTERRUPTED / FLAGGED_FOR_REVIEW ───┴──┬──┘
 *                                               ├─► IN_PROGRESS (admin-approved re-entry, resume code redeemed)
 *                                               └─► TERMINATED  (admin rejected re-entry / admin terminated; final)
 */
export const SESSION_STATUSES = [
  'CREATED',
  'IN_PROGRESS',
  'INTERRUPTED',
  'FLAGGED_FOR_REVIEW',
  'SUBMITTED',
  'EXPIRED',
  'TERMINATED',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const FINAL_SESSION_STATUSES: readonly SessionStatus[] = ['SUBMITTED', 'EXPIRED', 'TERMINATED'];
export const REVIEWABLE_SESSION_STATUSES: readonly SessionStatus[] = ['INTERRUPTED', 'FLAGGED_FOR_REVIEW'];

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  CREATED: 'Created',
  IN_PROGRESS: 'In progress',
  INTERRUPTED: 'Interrupted',
  FLAGGED_FOR_REVIEW: 'Terminated – under review',
  SUBMITTED: 'Submitted',
  EXPIRED: 'Auto-submitted (time expired)',
  TERMINATED: 'Terminated',
};

export const PROCTORING_EVENT_TYPES = [
  'TAB_HIDDEN',
  'WINDOW_BLUR',
  'CAMERA_DISCONNECTED',
  'MICROPHONE_DISCONNECTED',
  'NETWORK_OFFLINE',
  'NETWORK_RESTORED',
  'PAGE_UNLOAD',
  'MULTIPLE_FACES_DETECTED',
  'FACE_NOT_VISIBLE',
  'SPEECH_DETECTED',
  'CAMERA_MONITORING_UNAVAILABLE',
  'MICROPHONE_MONITORING_UNAVAILABLE',
  'SESSION_TERMINATED',
  'SESSION_INTERRUPTED',
  'SESSION_RESUMED',
] as const;
export type ProctoringEventType = (typeof PROCTORING_EVENT_TYPES)[number];

/** Event types the browser may report. SESSION_* events are server-generated only. */
export const CLIENT_EVENT_TYPES = [
  'TAB_HIDDEN',
  'WINDOW_BLUR',
  'CAMERA_DISCONNECTED',
  'MICROPHONE_DISCONNECTED',
  'NETWORK_OFFLINE',
  'NETWORK_RESTORED',
  'PAGE_UNLOAD',
  'MULTIPLE_FACES_DETECTED',
  'FACE_NOT_VISIBLE',
  'SPEECH_DETECTED',
  'CAMERA_MONITORING_UNAVAILABLE',
  'MICROPHONE_MONITORING_UNAVAILABLE',
] as const satisfies readonly ProctoringEventType[];
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

/**
 * Events produced by local (in-browser) camera/microphone analysis. They are
 * sustained-condition detections, so the server applies an extra per-type
 * cooldown on top of the client's own cooldown.
 */
export const DETECTION_EVENT_TYPES = ['MULTIPLE_FACES_DETECTED', 'FACE_NOT_VISIBLE', 'SPEECH_DETECTED'] as const satisfies readonly ClientEventType[];

/** Neutral, non-accusatory labels. */
export const EVENT_LABELS: Record<ProctoringEventType, string> = {
  TAB_HIDDEN: 'Tab switch detected',
  WINDOW_BLUR: 'Assessment window lost focus',
  CAMERA_DISCONNECTED: 'Camera disconnected',
  MICROPHONE_DISCONNECTED: 'Microphone disconnected',
  NETWORK_OFFLINE: 'Network connection lost',
  NETWORK_RESTORED: 'Network connection restored',
  PAGE_UNLOAD: 'Attempt to leave the assessment page',
  MULTIPLE_FACES_DETECTED: 'Multiple people detected',
  FACE_NOT_VISIBLE: 'Face not visible',
  SPEECH_DETECTED: 'Speech activity detected',
  CAMERA_MONITORING_UNAVAILABLE: 'Camera monitoring unavailable',
  MICROPHONE_MONITORING_UNAVAILABLE: 'Microphone monitoring unavailable',
  SESSION_TERMINATED: 'Session terminated',
  SESSION_INTERRUPTED: 'Session interrupted (connection lost)',
  SESSION_RESUMED: 'Session resumed after admin approval',
};

export const EVENT_ACTIONS = ['LOGGED', 'WARNING', 'TERMINATED', 'IGNORED'] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];

/**
 * How an event type is handled (configurable per event type in Settings):
 *  • TAB_SWITCH — warning; after `tabSwitchMaxWarnings` warnings the next one
 *                 terminates the session and flags it for admin review
 *  • GENERAL    — same, with `generalMaxWarnings` (shared counter for all GENERAL events)
 *  • WARN_ONLY  — warning shown and recorded, never terminates (default for the
 *                 imperfect on-device face/speech detections)
 *  • LOG_ONLY   — recorded silently
 */
export const EVENT_RULE_GROUPS = ['TAB_SWITCH', 'GENERAL', 'WARN_ONLY', 'LOG_ONLY'] as const;
export type EventRuleGroup = (typeof EVENT_RULE_GROUPS)[number];

export const REENTRY_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'USED', 'CANCELLED'] as const;
export type ReentryStatus = (typeof REENTRY_STATUSES)[number];

export const EVALUATION_STATUSES = ['NOT_EVALUATED', 'PENDING_MANUAL_REVIEW', 'COMPLETE'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

export const EVALUATION_STATUS_LABELS: Record<EvaluationStatus, string> = {
  NOT_EVALUATED: 'Not evaluated',
  PENDING_MANUAL_REVIEW: 'Coding review pending',
  COMPLETE: 'Evaluation complete',
};

export const ADMIN_ROLES = ['ADMIN', 'REVIEWER'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Header every state-changing request must carry (CSRF defence; see server/src/middleware/csrf.ts). */
export const CSRF_HEADER = 'x-test-orbit-request';
