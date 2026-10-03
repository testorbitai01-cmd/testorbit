# Test Orbit — Campus Recruitment Assessment Portal

Students register, pick an assessment domain, pass a camera/microphone check, confirm an identity photo and take a timed, server-controlled assessment (section-wise, MCQ + coding). Administrators manage domains, students, the question bank and papers (any number of sections), review proctoring events and interrupted sessions, approve re-entry, evaluate coding answers and export reports.

| Layer | Tech |
| --- | --- |
| Client | React 19, Vite 7, TypeScript, Tailwind CSS 4, React Router 7, TanStack Query, React Hook Form + Zod, Lucide, Recharts |
| Server | Node 20+/22, Express 5, TypeScript, Zod, server-side sessions in PostgreSQL (HTTP-only cookies), bcrypt |
| Data | PostgreSQL + Prisma 6 (migrations in `prisma/migrations`) |
| Tests | Vitest, React Testing Library, Supertest (against a real test database) |
| Deploy | One Railway web service + Railway PostgreSQL |

```
test-orbit/
├─ client/     React app (built to client/dist and served by the server in production)
├─ server/     Express API, background jobs, scripts (bootstrap admin, demo seed)
├─ shared/     Zod schemas, constants and import parsers used by BOTH client and server
├─ prisma/     schema.prisma, migrations, reference-data seed
├─ docs/       architecture, security & privacy, question import, Railway deployment
└─ railway.json
```

More detail: [docs/architecture.md](docs/architecture.md) · [docs/security-and-privacy.md](docs/security-and-privacy.md) · [docs/question-import.md](docs/question-import.md) · [docs/deployment-railway.md](docs/deployment-railway.md)

---

## 1. Run locally

**Prerequisites:** Node.js ≥ 20.19 (22 recommended), PostgreSQL 14+.

```bash
npm install
cp .env.example .env          # then edit it (see below)
```

Create two databases (the second is wiped by the automated tests):

```sql
CREATE DATABASE test_orbit;
CREATE DATABASE test_orbit_test;
```

Edit `.env`:

* `DATABASE_URL` / `TEST_DATABASE_URL` — your two databases.
* `SESSION_SECRET` — `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
* `ADMIN_BOOTSTRAP_PASSWORD` — at least 12 characters with upper-case, lower-case and a digit.

Then:

```bash
npm run db:deploy          # apply migrations
npm run db:seed            # the four initial domains + default settings (idempotent; add more in Admin → Domains)
npm run admin:bootstrap    # creates admin@gradtwin.com from the env vars (only if no admin exists)
npm run dev                # API on :4000, web app on http://localhost:5173 (proxies /api)
```

Open http://localhost:5173 for the student portal and http://localhost:5173/admin/login for the admin portal.

> Camera/microphone APIs need a secure context. `http://localhost` counts as secure; any other host must use HTTPS.

### Initial admin account

1. Put `ADMIN_BOOTSTRAP_EMAIL` (default `admin@gradtwin.com`) and `ADMIN_BOOTSTRAP_PASSWORD` in the environment — never in code, migrations or seed files.
2. Run `npm run admin:bootstrap`. It hashes the password with bcrypt and creates the account **only if no admin exists**, so running it on every deploy is safe.
3. Sign in at `/admin/login`. You are forced to choose a new password before anything else works (enforced by the API, not just the UI).
4. Remove `ADMIN_BOOTSTRAP_PASSWORD` from the environment afterwards (recommended). Further admins/reviewers are created under **Settings → Administrator accounts**; there is no public admin registration.

### Useful scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server (tsx watch) + client (Vite) together |
| `npm test` | Shared, server (Supertest + Postgres) and client (RTL) test suites |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` for all three packages |
| `npm run build` | Prisma client, client bundle (`client/dist`), server bundle (`server/dist`) |
| `npm start` | Production server (serves the API and the built client) |
| `npm run db:migrate` | Create a new migration during development (`prisma migrate dev`) |
| `npm run db:deploy` | Apply migrations (production-safe, never resets data) |
| `npm run railway:release` | `migrate deploy` + reference seed + admin bootstrap (Railway pre-deploy) |

## 2. Testing

`npm test` runs:

* **shared** — registration validation, CSV/JSON/text import parsers, CSV formula-injection escaping.
* **server** — Supertest integration tests against `TEST_DATABASE_URL` (migrated automatically, truncated between tests): registration & duplicates, device check/photo, admin auth/lockout/forced password change, authorization & CSRF, domain-specific randomised assignment, concurrency (double Start / double Submit), answer ordering, deadline enforcement & auto-submit, scoring & negative marking, warning policy (tab switch: warning 1 then terminate; general: warnings 1–2 then terminate; WARN_ONLY never terminates; configurable thresholds), idempotency/debounce/detection cooldown, re-entry after policy termination, metadata-only event details, acknowledgement, admin event history after submission, interruption, re-entry approve/reject/single-use codes/expiry, mark corrections with audit trail, CSV export, dashboard; plus unit tests for unbiased randomisation and scoring.
* **client** — autosave ordering/retry/flush, proctoring detection (tab hidden, refresh ≠ tab switch, track ended, offline queue), face-presence and speech-activity logic (thresholds, flicker tolerance, cooldowns), monitor hooks with mocked camera/Web Audio (failure handling, cleanup, no media leaves the browser), exam page warnings without logout/termination, third-party network guard, camera permission denial, registration validation, code editor.

The full browser flow (registration → device check with fake camera → assessment → warnings → termination → admin approval → resume on another browser → submit → evaluation → CSV) was also exercised manually against the production build with Playwright + Microsoft Edge's fake media devices.

## 3. Deploying to Railway

See [docs/deployment-railway.md](docs/deployment-railway.md). In short: one web service from this repo (uses `railway.json`), one PostgreSQL service, set the variables, attach a Volume for identity photos, generate a domain (HTTPS).

## 4. Key behaviours (summary)

* **Server is the clock.** Deadline is computed and enforced server-side; the UI countdown is display only (monotonic, re-synced every 20 s). Late answers are rejected (5 s configurable network grace); expired sessions are auto-submitted by a background sweeper even if the student never returns.
* **Fixed paper per session.** Questions are drawn per section with a CSPRNG Fisher–Yates shuffle, option order optionally shuffled, then stored in `SessionQuestion`. Refresh, reconnect or resume never redraws.
* **Autosave you can trust.** Each change carries a monotonic sequence number; the database only applies newer saves. “Saved” appears only after the server confirms.
* **Proctoring = transparent event logging**, not cheating detection. Tab switches, focus loss, camera/microphone disconnection, and on-device detections of *face not visible*, *multiple people* and *speech activity* show a non-blocking, timestamped warning ("Warning n of max") and are stored as metadata for admin review. Default policy: **tab switch** → warning 1, the 2nd switch terminates the session; **window focus / camera / microphone** (general rule) → warning 1, warning 2, the 3rd terminates. A terminated session keeps its answers and frozen remaining time and waits for admin review on the Re-entry page (never auto-approved). The imperfect face/speech detections default to *warn only* (never terminate). Each event type's rule, the thresholds, intervals and cooldowns are configurable in Settings; counts are server-side. Events never log the student out or submit the assessment. Video/audio are processed only in the browser and never recorded, stored or uploaded.
* **Re-entry needs an admin.** Interrupted/terminated sessions freeze their remaining time. An admin approval issues a single-use, expiring 8-character resume code; redeeming it restores the same session (questions, order, answers, last question) with the frozen time plus any approved adjustment.
* **Audit everything.** Logins, password changes, question/paper changes, re-entry decisions, coding evaluations, mark corrections (old/new/reason), exports, photo views and settings changes.

## 5. Known limitations / decisions

* Client-side proctoring can be bypassed (e.g. a second device) and on-device face/speech detection produces false positives/negatives. It is presented as event logging only; tune thresholds under real exam-room conditions (accuracy has not been measured on real users).
* Phone validation targets Indian mobile numbers (10 digits, 6–9 start, optional +91).
* One assessment attempt per student registration.
* Returning students can sign in with registration number + mobile **only before starting**; afterwards access requires an admin resume code.
* Rate limiting uses in-memory stores (correct for the single Railway instance this is designed for).
* `npm audit` reports a `deepmerge-ts` advisory inside the Prisma 6 CLI's config loader (build/release-time tool, no user input reaches it).
