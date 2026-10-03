# Security & privacy

## Camera, microphone and identity photo

* Camera and microphone streams are used **only in the student's browser**: the live preview, the microphone test, and — during the assessment — on-device checks for "face not visible", "multiple people" and "speech activity". Frames and audio samples exist only in memory while being analysed and are immediately discarded. Nothing is recorded (no `MediaRecorder`), streamed, uploaded, transcribed or stored, and no screenshots, face crops, embeddings or voiceprints are created.
* The server receives **event metadata only** (type, server time, occurrence number, and values such as duration, face count, detector confidence or audio level). The API rejects media-like content in event details (data URLs, base64-like strings, nested data, bodies > 4 KB).
* The face detector runs from self-hosted files (`/mediapipe/wasm`, `/models`). The MediaPipe library tries to send usage metrics to Google; an app-wide network guard (`client/src/services/networkGuard.ts`) blocks every non-same-origin `fetch`/`sendBeacon`, and the production CSP (`connect-src 'self'`) blocks it again in the browser. `script-src` allows `'wasm-unsafe-eval'` for WebAssembly only (not `'unsafe-eval'`).
* Automatic detection is imperfect (background voices, TV, noise, lighting, camera angle, glasses/masks, posters or photos in view). Students are told this before and during the assessment; admins see events as review material, never as proof of misconduct. Thresholds are configurable in **Settings** and should be tuned in the actual exam rooms.
* The **only** media that leaves the browser is one still JPEG that the student captures, reviews, can retake, and explicitly confirms (with a consent checkbox) on the device-check page.
* No facial recognition or automated identity scoring is performed.
* Media is released as soon as the assessment is submitted or ends.

### Identity-photo policy (configurable)

| Aspect | Policy |
| --- | --- |
| Collection | Optional per **Settings → Require a confirmed identity photo** (default on). Server-wide kill switch: `PHOTO_STORAGE_DRIVER=disabled` (nothing stored). |
| Storage | `PHOTO_STORAGE_DRIVER=local` writes files to `PHOTO_STORAGE_DIR` (mode 0600, atomic write). In production this must be a **Railway Volume** mount. PostgreSQL stores only `storageKey`, MIME type, size, SHA-256 and dates — never image bytes or base64. |
| Validation | Max 1.5 MB, JPEG/PNG/WebP detected by magic bytes; uploads are blocked once the assessment has started. A recapture replaces (and deletes) the previous photo. |
| Access | Only authenticated admins/reviewers via `GET /api/admin/students/:id/photo`, which sends `Cache-Control: no-store` and **writes an audit-log entry for every view**. The UI asks before revealing it. Photos are never in public URLs or CSV exports. |
| Retention | `retentionDays` (default 180). An hourly job deletes expired files and marks the metadata deleted (audit-logged as `IDENTITY_PHOTOS_PURGED`). |

## Authentication & sessions

* Admin and student sessions are server-side rows; the browser holds a 256-bit random token in an **HTTP-only, SameSite=Lax** cookie (`Secure` and the `__Host-` prefix in production). The database stores only an HMAC-SHA-256 of the token (keyed with `SESSION_SECRET`).
* A new token is issued on every login/registration/resume and any presented old token is deleted (session fixation defence). Logout deletes the row. Admin sessions: 2 h idle / 12 h absolute. Password change signs out all other sessions.
* Passwords: bcrypt (cost 12), policy ≥ 12 chars with upper, lower and digit. Unknown emails still run bcrypt (no timing oracle) and get the same generic error. 10 failures lock the account for 15 min; login is also rate-limited per IP+email.
* The bootstrap admin password comes only from `ADMIN_BOOTSTRAP_PASSWORD` and must be changed at first sign-in — enforced server-side (`403 PASSWORD_CHANGE_REQUIRED` on every admin API until changed).
* No public admin registration; admins create other admins/reviewers in Settings.

## Authorization

* Every `/api/admin/*` route is behind `requireAdmin()`; question bank (answer keys), papers, re-entry decisions, audit logs, settings and CSV export require role `ADMIN`. Student cookies are rejected on admin routes.
* Students can only access their own session: every assessment endpoint loads the session under a row lock and compares `studentId` with the authenticated session; mismatches return 404 (no existence leak).
* Student IDs, domains, scores, warning counts, deadlines and roles are never taken from the client.
* Student API responses never include `isCorrect`, explanations or the question bank; question content is withheld once a session is not in progress.

## Web security

| Risk | Mitigation |
| --- | --- |
| SQL injection | Prisma queries; the few raw queries use tagged-template parameters |
| XSS | React escaping; question text and code answers rendered as text (`<pre>`/`whitespace-pre-wrap`), never as HTML; strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`) |
| CSRF | SameSite=Lax cookies + mandatory custom header `x-test-orbit-request: 1` on state-changing requests (no CORS is enabled, so other origins cannot send it) + Origin check |
| IDOR | Ownership checks on every student resource; admin routes role-checked |
| Brute force | Rate limits (sized for shared campus NAT), account lockout, resume-code attempt limit + expiry |
| CSV injection | Cells starting with `= + - @` are prefixed with `'`; exports exclude personal email, location, answers, keys and photos; every export is audit-logged with its filters |
| Headers | Helmet (HSTS, nosniff, referrer policy…), `Permissions-Policy: camera=(self), microphone=(self)`, `Cache-Control: no-store` on API responses |
| Secrets | Only in environment variables; env validation prints variable names, never values; logs never include request bodies |
| Code execution | Coding answers are stored as text and **never executed** |

## Limits of browser proctoring

Client-side detection can be bypassed (another device, virtual machines, browser modifications, covering the microphone), and it produces false positives and false negatives. The system records neutral events, terminates a session only by the configured warning policy (always reviewable and reversible by an admin via re-entry; face/speech detections warn only by default), and enforces session state, time and access rules on the server; it does not claim to detect all cheating, and no event is labelled as confirmed misconduct. Detection quality has been verified only with mocked inputs and a synthetic browser test feed — validate it under real conditions before relying on it.
