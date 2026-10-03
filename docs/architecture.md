# Architecture

## Overview

```
Browser (React SPA) ──/api (same origin, HTTP-only cookie)──► Express 5 API ──Prisma──► PostgreSQL
                                                               │
                                                               ├─ background jobs (in-process): deadline/heartbeat sweeper,
                                                               │   expired-session purge, photo-retention purge
                                                               └─ photo storage driver (local dir / Railway Volume, or disabled)
```

In production a single Node process serves both the API (`/api/*`) and the built React app (everything else, SPA fallback). In development Vite serves the client on :5173 and proxies `/api` to :4000.

`shared/` holds the Zod schemas (registration, questions, papers, settings, assessment payloads), constants (domains, statuses, event labels) and the deterministic import parsers, so the browser and the server validate with exactly the same rules. The server bundle inlines it (tsup `noExternal`).

### Server layout

```
server/src
├─ app.ts / index.ts           express app, security headers, static client, startup/shutdown
├─ config/env.ts               validated environment (fails fast, prints names only)
├─ lib/                        prisma, sessions, crypto, audit, settings, storage, errors, password
├─ middleware/                 auth (requireAdmin/requireRole/requireStudent), csrf, rate limits, errors
├─ modules/
│  ├─ auth/                    admin login/logout/me/change-password
│  ├─ students/                register, sign-in, me, change domain, session status
│  ├─ deviceCheck/             identity photo upload, device-check completion
│  ├─ assessment/              assignment.ts (pure), scoring.ts (pure), lifecycle.ts (state machine),
│  │                           assessment.service.ts, assessment.routes.ts
│  └─ admin/                   dashboard, students, assessments, questions (+import), papers,
│                              reentry, reports (+CSV), audit, settings (+admin users), domains
├─ jobs/sweeper.ts
└─ scripts/                    bootstrapAdmin.ts
```

Routes validate input with Zod, call services, and services own transactions. Every admin router sits behind `requireAdmin()`; answer keys, papers, re-entry, audit logs and settings additionally require the `ADMIN` role (reviewers can read student/assessment data and enter coding marks).

## Data model (Prisma)

| Model | Purpose |
| --- | --- |
| `AdminUser`, `AdminSession` | Admin accounts (bcrypt hash, role, lockout, must-change-password) and server-side sessions (token hash only) |
| `Student`, `StudentAuthSession`, `EducationRecord` | Registration, student sessions, SSC/HSC/UG/(PG) records with grading type |
| `Domain` | Managed in Admin → Domains (seeded with AI/ML, Data Analytics, Full Stack - Java, Full Stack - Python). Unique name and slug; deletable only while unused, otherwise closed |
| `Question`, `QuestionOption` | Bank; options carry `isCorrect` (never sent to students); `contentHash` + `externalRef` for duplicate imports |
| `QuestionPaper`, `PaperSection` | Named paper per domain (≤ 1 active) with any number of sections (1–50, default A–E). A section's `key` selects the domain's questions tagged with that section; requested counts may not exceed the eligible pool (active, not archived) |
| `AssessmentSession` | One attempt: status, start, authoritative deadline, frozen remaining time, heartbeat, scores |
| `SessionQuestion` | The fixed randomised assignment: position, section, option order, mark snapshot, marks awarded, evaluator |
| `StudentAnswer` | Latest answer per session question with monotonic `clientSeq` |
| `ProctoringEvent` | Event type, server time, rule group, per-type occurrence number, action (warning/logged), metadata `details`, `acknowledgedAt`, client event id (unique per session) |
| `ReentryRequest` | Pending/approved/rejected/used/cancelled, decision, time adjustment, resume-code hash + expiry |
| `IdentityPhoto` | Storage key + metadata only (bytes live in the storage driver), retention date |
| `AdminAuditLog` | Who did what, when, to which entity, with structured details |
| `SystemSetting` | Policy settings (JSON validated by `settingsSchema`) |

Assessment history is protected with `onDelete: Restrict` from students, papers and questions. Questions already used in a session cannot be deleted and their scoring fields (domain, section, type, marks, options/answer key) cannot change; wording/explanation/difficulty/status can.

## Session state machine

```
CREATED ─► IN_PROGRESS ─┬─► SUBMITTED            (student submits)
                        ├─► EXPIRED              (deadline + grace passed; auto-submitted & scored)
                        ├─► INTERRUPTED ───┐     (no heartbeat for heartbeatTimeoutSeconds, before the deadline)
                        ├─► FLAGGED_FOR_REVIEW ┐ (proctoring warning limit exceeded — "terminated" for the student)
                        └─► TERMINATED          (admin ended it)
INTERRUPTED / FLAGGED_FOR_REVIEW ─┬─► IN_PROGRESS (admin approval + resume code redeemed)
                                  └─► TERMINATED  (re-entry rejected / admin ended it; saved answers scored)
```

All transitions run inside a transaction holding `SELECT … FOR UPDATE` on the session row (`lifecycle.ts`), so concurrent submits, sweeps, admin actions and answer saves are serialised. Invalid transitions throw `409 INVALID_SESSION_TRANSITION`.

### Time

* `Start Test` sets `startedAt` and `deadlineAt = now + duration` on the server (UTC, `timestamptz`).
* While `IN_PROGRESS`, remaining = `deadlineAt − now` (server clock). The browser shows a countdown anchored to the server's remaining time using `performance.now()`, re-synced on every heartbeat — changing the PC clock has no effect.
* Pausing (interrupted/flagged) stores `frozenRemainingMs`, so time spent waiting for an admin does not count. Resuming sets a new deadline `now + frozenRemainingMs + approved adjustment`.
* Answers after `deadline + answerGraceSeconds` (default 5 s) are rejected; the session is finalised as `EXPIRED`.

### Randomisation

For each section in A→E order: load active questions of the paper's domain and section, check the pool size, take a CSPRNG Fisher–Yates shuffle (`crypto.randomInt`) and keep the first *n* (uniform selection, random order), optionally shuffle MCQ option **ids**, snapshot marks (section override or question marks; negative marks only if the paper enables them) and store `SessionQuestion` rows. The (studentId, attemptNumber) unique key plus a row lock on the student make Start idempotent.

### Answer saving

`INSERT … ON CONFLICT (sessionQuestionId) DO UPDATE … WHERE stored.clientSeq < new.clientSeq`. Sequence numbers are `max(Date.now(), last + 1)` at the moment of the edit and continue from the highest stored value after a refresh, so an older in-flight request can never overwrite a newer answer.

### Scoring

At finalisation: MCQ correct → +marks, wrong → −negativeMarks (0 unless enabled), unanswered → 0. Coding answers stay `marksAwarded = null` (pending) until a reviewer enters marks; blank coding answers score 0 automatically. Totals are only computed when nothing is pending. Later changes go through audited corrections and recompute totals.

## Proctoring

Browser side (`useProctoring`): Page Visibility (`TAB_HIDDEN`), window blur sustained > 2 s while visible (`WINDOW_BLUR`), media track `ended` (`CAMERA_/MICROPHONE_DISCONNECTED`), `offline`/`online` (queued, reported on reconnect with duration) and `pagehide` (`PAGE_UNLOAD`, sent with `keepalive`; a refresh is therefore not miscounted as a tab switch). Each event has a UUID so retries are processed once.

On-device monitoring during the assessment (`client/src/proctoring/`):

* **Face** — `useFaceMonitor` runs the MediaPipe BlazeFace short-range detector (self-hosted WebAssembly + model in `client/public`, loaded lazily) on the live preview `<video>` every `faceDetectionIntervalMs`. Faces below `faceMinConfidence` are ignored. `FaceMonitor` (pure logic) turns per-frame counts into episodes: no face for `faceAbsenceSeconds` → `FACE_NOT_VISIBLE`; ≥ 2 faces for `multipleFacesSeconds` → `MULTIPLE_FACES_DETECTED`. Episodes tolerate brief detector flicker (grace = 2 intervals, ≥ 1.5 s), are reported once each, and at most once per `eventCooldownSeconds` per type.
* **Speech activity** — `useSpeechMonitor` feeds the microphone into a Web Audio `AnalyserNode` (never a recorder) and every 100 ms computes the RMS level and the share of spectral energy in the 300–3400 Hz voice band. `SpeechActivityDetector` marks a frame voiced when it is above an adaptive background-noise floor by `speechNoiseMarginDb`, above `speechMinLevelDb`, and voice-band dominated; sustained activity for `speechMinDurationMs` (pauses < 450 ms bridged, ≥ 50 % voiced) → `SPEECH_DETECTED`, once per episode and cooldown. It does not identify speakers or content.
* If the detector or Web Audio cannot start, `CAMERA_/MICROPHONE_MONITORING_UNAVAILABLE` is logged and the student is told; the assessment continues.
* All tracks are stopped when the exam room unmounts or the assessment ends.

Warnings are shown immediately (non-blocking panel beside the question, coalesced per event type, max three, timestamped, dismissable — dismissal is stored as `acknowledgedAt`).

Server side (`recordEvent`): idempotent on `(sessionId, clientEventId)`, debounced per event type (`dedupeWindowSeconds`), plus a server-side `eventCooldownSeconds` for detection events so a misbehaving client cannot flood the log. Each event type is configured in **Settings** with a rule: `TAB_SWITCH` (warnings 1…`tabSwitchMaxWarnings`, default 1, then terminate), `GENERAL` (shared counter, warnings 1…`generalMaxWarnings`, default 2, then terminate), `WARN_ONLY` (warning, never terminates — default for face/speech detections) or `LOG_ONLY`. Counts come from the database, so a refresh or new tab cannot reset them. Termination pauses the session as `FLAGGED_FOR_REVIEW` (answers and questions preserved, remaining time frozen), logs `SESSION_TERMINATED` and opens a `POLICY_TERMINATION` re-entry request; it is never auto-approved. The response carries `warningNumber`/`maxWarnings`, the per-type occurrence number and the server timestamp. Events never log the student out or submit the assessment. Event `details` accept only small, flat metadata (≤ 12 keys, short strings, numbers, booleans); data URLs, base64-like strings, arrays/objects and bodies over 4 KB are rejected. Labels are neutral ("Tab switch detected", "Speech activity detected").

## Re-entry

1. Interruption/termination automatically creates a `PENDING` request; the student sees status + support instructions and may add a note.
2. An admin reviews answers, unanswered questions, remaining time and the event history, then approves (optional −60…+60 min adjustment) or rejects with a reason. Everything is audit-logged.
3. Approval generates an 8-character code from an unambiguous alphabet, stores only its HMAC, valid for `resumeCodeTtlMinutes` (default 60). It is shown to the admin once. Five wrong attempts invalidate it; the admin can issue a new one.
4. The student enters registration number + code on `/session-status` (any computer). The code is consumed, a new student session cookie is issued, and the original session resumes.
5. Rejection finalises the session as `TERMINATED` (answers scored) and shows the reason to the student. Submitted/expired/terminated sessions can never be approved.

## Deleting students and questions

Deletion never breaks assessment history.

**Students**

| No assessment history | Finished assessments | Assessment in progress / under review |
| --- | --- | --- |
| Hard delete (education, sign-in sessions, identity photo cascade; photo file removed) | **Archived** (`Student.archivedAt`): hidden from the student list, cannot sign in or resume; results, answers, events, re-entry requests and audit logs kept | Refused (409) |

"Delete all students" applies the same policy to every student (skipping active ones).

**Questions**

* **Permanently delete** (`DELETE /admin/questions/:id`, or "Delete all questions" for one domain / all domains, confirm `DELETE`) removes the question and its options from the database, whether or not it was used. In the same transaction, every `SessionQuestion` that used it receives a `questionSnapshot` (type, text, difficulty, explanation, options with answer key) and its `questionId` becomes `NULL` (FK `ON DELETE SET NULL`). `StudentAnswer.selectedOptionId` is a plain column (no FK), so recorded answers keep pointing at the snapshot's option ids. Results, scoring, reports, coding evaluation and in-progress assessments read the live question while it exists and the snapshot afterwards. Bulk delete also removes previously archived questions in the scope.
* **Archive** (`POST /admin/questions/:id/archive`, or bulk with confirm `ARCHIVE`) hides the question from the bank and future pools without deleting it; it is refused if an active paper section would run short.

Deleting never deactivates papers. If it leaves an active paper short, the dialog says so (paper, section, required / remaining) and new students cannot start that paper until it has enough questions again; assessments in progress keep their questions. All operations are ADMIN-only, run in one transaction (all or nothing) and are audit-logged (`QUESTION_DELETED`, `QUESTION_ARCHIVED`, `QUESTIONS_BULK_DELETED`, `QUESTIONS_BULK_ARCHIVED`).
