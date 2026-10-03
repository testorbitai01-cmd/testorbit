import type {
  AdminRole,
  ClientEventType,
  Difficulty,
  EducationLevel,
  EvaluationStatus,
  EventAction,
  EventRuleGroup,
  GradeType,
  MonitoringSettings,
  ProctoringEventType,
  QuestionType,
  ReentryStatus,
  SectionKey,
  SessionStatus,
  Settings,
} from '@test-orbit/shared';

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ───────────── Student ─────────────

export type NextStep = 'device-check' | 'instructions' | 'assessment' | 'submitted' | 'session-status';

export interface EducationRecord {
  level: EducationLevel;
  institutionName: string;
  yearOfCompletion: number;
  major: string | null;
  gradeType: GradeType;
  score: number;
}

export interface StudentProfile {
  student: {
    id: string;
    fullName: string;
    registrationNumber: string;
    mobileNumber: string;
    collegeEmail: string;
    personalEmail: string;
    collegeName: string;
    location: string;
    department: string;
    yearOfPassing: number;
    domain: { slug: string; name: string };
    domainLocked: boolean;
    education: EducationRecord[];
  };
  deviceCheck: { completed: boolean; completedAt: string | null; photoRequired: boolean; photoCaptured: boolean };
  session: { id: string; status: SessionStatus } | null;
  nextStep: NextStep;
}

export interface AvailablePaper {
  domain: { slug: string; name: string };
  checks: { registration: boolean; deviceCheck: boolean; identityPhoto: boolean };
  paper: {
    name: string;
    description: string;
    durationMinutes: number;
    totalQuestions: number;
    negativeMarkingEnabled: boolean;
    sections: { key: SectionKey; title: string; questionCount: number }[];
  } | null;
  proctoring: {
    tabSwitchMaxWarnings: number;
    generalMaxWarnings: number;
    eventRules: Record<ClientEventType, EventRuleGroup>;
    faceDetectionEnabled: boolean;
    speechDetectionEnabled: boolean;
  };
  existingSession: { id: string; status: SessionStatus } | null;
}

export interface SessionInfo {
  id: string;
  status: SessionStatus;
  statusLabel: string;
  startedAt: string | null;
  deadlineAt: string | null;
  remainingMs: number;
  durationMinutes: number;
  lastQuestionPosition: number | null;
  terminationReason: string | null;
}

export interface AssessmentQuestion {
  id: string;
  position: number;
  section: SectionKey;
  sectionTitle: string;
  sectionPosition: number;
  type: QuestionType;
  text: string;
  marks: number;
  negativeMarks: number;
  options: { id: string; text: string }[];
}

export interface SavedAnswer {
  selectedOptionId: string | null;
  answerText: string | null;
  clientSeq: number;
  savedAt: string;
}

export interface FinalSummary {
  submittedAt: string | null;
  submissionReason: string | null;
  totalQuestions: number;
  answeredCount: number;
  score: { mcqScore: number | null; mcqMaxScore: number | null } | null;
}

export interface AssessmentView {
  serverNow: string;
  session: SessionInfo;
  student: { fullName: string; registrationNumber: string; domainName: string };
  paper: { name: string };
  summary?: FinalSummary | null;
  sections?: { key: SectionKey; title: string; count: number }[];
  questions?: AssessmentQuestion[];
  answers?: Record<string, SavedAnswer>;
  proctoring?: {
    eventRules: Record<ClientEventType, EventRuleGroup>;
    tabSwitchMaxWarnings: number;
    generalMaxWarnings: number;
    monitoring: MonitoringSettings;
    warnings: { TAB_SWITCH: number; GENERAL: number };
  };
  heartbeatIntervalSeconds?: number;
}

export interface EventResult {
  action: EventAction;
  warningNumber?: number | null;
  /** Warnings allowed before termination for this event's rule (null = never terminates). */
  maxWarnings?: number | null;
  eventCount?: number;
  ruleGroup?: string;
  /** Server timestamp of the stored event. */
  recordedAt?: string;
  status: SessionStatus;
  duplicate?: boolean;
}

export interface SessionStatusResponse {
  session: (SessionInfo & { submittedAt: string | null }) | null;
  reentry: {
    id: string;
    status: ReentryStatus;
    trigger: 'NETWORK_INTERRUPTION' | 'POLICY_TERMINATION';
    requestedAt: string;
    decidedAt: string | null;
    decisionReason: string | null;
    codeExpiresAt: string | null;
    studentNote: string | null;
  } | null;
}

// ───────────── Admin ─────────────

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  mustChangePassword: boolean;
}

export interface QuestionRecord {
  id: string;
  domain: { slug: string; name: string };
  section: SectionKey;
  type: QuestionType;
  text: string;
  marks: number;
  negativeMarks: number;
  difficulty: Difficulty;
  explanation: string | null;
  isActive: boolean;
  externalRef: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
  options: { id: string; text: string; isCorrect: boolean; position: number }[];
}

export interface PaperRecord {
  id: string;
  name: string;
  description: string;
  domain: { slug: string; name: string };
  durationMinutes: number;
  shuffleOptions: boolean;
  negativeMarkingEnabled: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  totalQuestions: number;
  sessionCount: number;
  activeSessionCount: number;
  editable: boolean;
  sections: {
    key: SectionKey;
    title: string;
    position: number;
    questionCount: number;
    marksPerQuestion: number | null;
    negativeMarksPerQuestion: number | null;
    available: { total: number; mcq: number; coding: number };
  }[];
  shortfalls: { section: SectionKey; required: number; available: number }[];
  ready: boolean;
}

export interface SessionEvent {
  id: string;
  type: ProctoringEventType;
  label: string;
  ruleGroup: string;
  eventCount: number;
  action: EventAction;
  warningNumber: number | null;
  details: Record<string, unknown> | null;
  clientTime: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface ReentryRecord {
  id: string;
  trigger: 'NETWORK_INTERRUPTION' | 'POLICY_TERMINATION';
  status: ReentryStatus;
  remainingMsAtRequest: number;
  studentNote: string | null;
  decidedBy: { name: string; email: string } | null;
  decidedAt: string | null;
  decisionReason: string | null;
  timeAdjustmentMinutes: number;
  resumeCodeExpiresAt: string | null;
  codeActive: boolean;
  usedAt: string | null;
  createdAt: string;
}

export interface SessionQuestionDetail {
  id: string;
  questionId: string;
  externalRef: string | null;
  position: number;
  section: SectionKey;
  sectionTitle: string;
  sectionPosition: number;
  type: QuestionType;
  difficulty: Difficulty;
  text: string;
  marks: number;
  negativeMarks: number;
  options: { id: string; text: string; isCorrect: boolean | null }[];
  answered: boolean;
  selectedOptionId: string | null;
  answerText: string | null;
  savedAt: string | null;
  isCorrect: boolean | null;
  marksAwarded: number | null;
  evaluatedAt: string | null;
  evaluatedBy: { name: string; email: string } | null;
  evaluatorComment: string | null;
}

export interface SessionDetail {
  id: string;
  status: SessionStatus;
  statusLabel: string;
  attemptNumber: number;
  paper: { id: string; name: string; domainName: string; negativeMarkingEnabled: boolean };
  durationMinutes: number;
  timeAdjustmentMinutes: number;
  startedAt: string | null;
  deadlineAt: string | null;
  submittedAt: string | null;
  finalizedAt: string | null;
  submissionReason: string | null;
  interruptedAt: string | null;
  terminatedAt: string | null;
  terminationReason: string | null;
  lastHeartbeatAt: string | null;
  lastAnswerSavedAt: string | null;
  lastQuestionPosition: number | null;
  resumeCount: number;
  remainingMs: number;
  timeUsedMs: number;
  scores: {
    mcqScore: number | null;
    mcqMaxScore: number | null;
    codingScore: number | null;
    codingMaxScore: number | null;
    totalScore: number | null;
    maxScore: number | null;
    evaluationStatus: EvaluationStatus;
  };
  answeredCount: number;
  totalQuestions: number;
  sections: { key: SectionKey; title: string; total: number; answered: number; mcqScore: number; mcqMax: number; codingScore: number; codingMax: number; pending: number }[];
  questions: SessionQuestionDetail[];
  events: SessionEvent[];
  reentryRequests: ReentryRecord[];
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: unknown;
  admin: { id?: string; name: string; email: string } | null;
  ipAddress?: string | null;
  createdAt: string;
}

export interface StudentDetail {
  student: StudentProfile['student'] & { domainLockedAt: string | null; deviceCheckCompletedAt: string | null; createdAt: string; archivedAt: string | null };
  photo: { available: boolean; confirmedAt?: string; retentionUntil?: string; sizeBytes?: number };
  sessions: SessionDetail[];
  auditHistory: AuditEntry[];
}

export type { Settings };
