# Test Orbit — Campus Recruitment Assessment Portal

Test Orbit is a server-authoritative assessment engine for campus recruitment drives. Students register, pass a camera/microphone check, confirm an identity photo, and take a timed, randomised assessment (MCQ + coding) with on-device proctoring. The server owns the clock, the question assignment, scoring and every state transition; the browser is never trusted.

**Stack:** React 19 + Vite SPA · Express 5 API (Node ≥ 20.19) · Prisma 6 · PostgreSQL (Supabase) · Railway · Cloudflare (CDN)

> [!CAUTION]
> **Never put a real connection string, password or database export in this repository.** Credentials belong in `.env` (git-ignored) and Railway variables. `backups/` is git-ignored because exports contain admin password hashes, every answer key and student PII.

---

## Contents

1. [Capacity target: 2,000 concurrent students](#1-capacity-target-2000-concurrent-students)
2. [Production architecture](#2-production-architecture)
3. [Architecture decisions that must be right before a drive](#3-architecture-decisions-that-must-be-right-before-a-drive)
4. [What has been optimised (and where)](#4-what-has-been-optimised-and-where)
5. [Configuration](#5-configuration)
6. [Request flows](#6-request-flows)
7. [Local development & tests](#7-local-development--tests)
8. [Database migration status & backups](#8-database-migration-status--backups)
9. [Exam-day runbook](#9-exam-day-runbook)
10. [Known risks & roadmap](#10-known-risks--roadmap)

Deeper references: [docs/architecture.md](docs/architecture.md) (state machine, proctoring, re-entry, deletion rules) · [docs/deployment-railway.md](docs/deployment-railway.md) · [docs/security-and-privacy.md](docs/security-and-privacy.md) · [docs/question-import.md](docs/question-import.md)

---

## 1. Capacity target: 2,000 concurrent students

A drive has three load phases. The numbers below come from the code's actual behaviour, not estimates of a generic app.

| Phase | What happens | Load |
| :--- | :--- | :--- |
| **Launch spike** (2–3 min) | Every browser downloads the SPA and the MediaPipe face-detection runtime, then registers / starts. | ~12.5 MB per student (11.7 MB SIMD WASM + 0.3 MB loader + 0.23 MB model + app JS) ⇒ **≈ 25 GB** of static transfer. Registrations: 2,000 from one or two NAT IPs. |
| **Steady state** (test duration) | Heartbeat every 30 s (±15 %), MCQ autosave on every click, debounced coding autosave, proctoring events. | ≈ 67 heartbeats/s + 40–130 saves/s + events ⇒ **~150–250 API req/s**, all from one or two public IPs. |
| **Submission avalanche** (10–30 s) | Timers hit zero; every browser flushes answers and submits; the sweeper expires anyone who closed the tab. | Up to ~200 finalisations/s, each scoring a full paper inside one locked transaction. |

What actually limits this system (in order):

1. **Database round-trip latency.** Every request runs several sequential SQL statements, and the locked ones (save, submit, events) hold a pooled connection for the whole sequence. At 1 ms per round trip that is trivial; at 70–150 ms (cross-region) a save takes ~1 s, the pool saturates, and requests queue until they time out. **Region co-location matters more than any code change** — see [§3.1](#31-put-the-api-and-the-database-in-the-same-region).
2. **Static bandwidth from Node** — solved by the CDN ([§3.4](#34-cloudflare-in-front-of-railway)).
3. **Shared NAT IPs** — solved by session-keyed rate limits ([§4](#4-what-has-been-optimised-and-where)).

Row-lock contention is *not* a global bottleneck: every lock is on one student's own `AssessmentSession` row, so students never wait for each other — only for their own concurrent requests.

---

## 2. Production architecture

```
                 ┌─────────────────────────── STUDENT BROWSER ───────────────────────────┐
                 │ React 19 SPA · MediaPipe face detector (WASM) + Web Audio, on-device  │
                 │ useAnswerSync (monotonic clientSeq, retry/backoff) · jittered heartbeat│
                 └───────────────┬───────────────────────────────────────┬───────────────┘
                   static files  │                                       │  /api/*  (HTTPS, HttpOnly
                   (JS, CSS,     │                                       │  cookie, X-CSRF header)
                   WASM, model)  ▼                                       ▼
                 ┌──────────────────────────────────────────────────────────────────────┐
                 │ CLOUDFLARE (proxied DNS, custom domain)                               │
                 │ • caches /assets/* (immutable) and /mediapipe/*, /models/* (7 days)   │
                 │ • /api/* bypasses cache, passed through to Railway                    │
                 └───────────────────────────────────┬──────────────────────────────────┘
                                                     │ cache misses + all /api
                                                     ▼
                 ┌──────────────────────────────────────────────────────────────────────┐
                 │ RAILWAY web service × 2 replicas (region = same as database)          │
                 │ Express 5: helmet/CSP · cookie session · CSRF · rate limits · Zod     │
                 │ In-process jobs: platform clock · sweeper (SKIP LOCKED) · purges      │
                 │ Identity photos → private Supabase Storage bucket (§3.3)              │
                 └───────────────────────────────────┬──────────────────────────────────┘
                                 Prisma, pool capped by connection_limit per replica
                                                     ▼
                 ┌──────────────────────────────────────────────────────────────────────┐
                 │ SUPABASE SUPAVISOR POOLER                                             │
                 │ :6543 transaction mode → app runtime (DATABASE_URL, pgbouncer=true)   │
                 │ :5432 session mode     → prisma migrate only (DIRECT_URL)             │
                 └───────────────────────────────────┬──────────────────────────────────┘
                                                     ▼
                 ┌──────────────────────────────────────────────────────────────────────┐
                 │ SUPABASE POSTGRESQL — single source of truth                          │
                 │ session state machine · authoritative deadline · answers · scores     │
                 │ Data API (PostgREST) disabled / anon grants revoked (see §3.5)        │
                 └──────────────────────────────────────────────────────────────────────┘
```

There is **no Redis** and none is needed: all shared state lives in PostgreSQL, and the only in-memory state (rate-limit counters, a 5-second settings cache) is safe to keep per replica.

---

## 3. Architecture decisions that must be right before a drive

### 3.1 Put the API and the database in the same region

The current Supabase pooler host is `aws-0-ap-northeast-1` (**Tokyo**). If the Railway service runs anywhere else (Railway's default is US West), every SQL statement crosses an ocean.

| Placement | Typical RTT per statement | `saveAnswer` (~8 statements in one transaction) |
| :--- | :--- | :--- |
| Same region (e.g. both Singapore) | ~1 ms | ~10 ms |
| Singapore ↔ Tokyo | ~70 ms | ~0.6 s |
| US West ↔ Tokyo | ~110–150 ms | ~1 s+ (pool saturates at exam load) |

**Recommendation:** students are in India, so use **Railway `asia-southeast1` (Singapore) + Supabase `ap-southeast-1` (Singapore)**; Supabase `ap-south-1` (Mumbai) + Railway Singapore is the second choice. Supabase cannot move a project between regions, but the database currently holds only master data (0 students, 0 sessions), so creating a new project in the right region and re-running the restore ([§8](#8-database-migration-status--backups)) is a 15-minute job **now** and impossible to do safely mid-season.

Verify after deploying: `GET /api/health` latency should be < 20 ms from the Railway shell; the Supabase *Query Performance* report should show mean execution times in single-digit ms.

### 3.2 Size the Prisma pool against the Supabase pooler

Prisma's default pool size is `2 × CPU cores + 1`, and inside a container Node sees the **host's** cores — on Railway that can be 30+ connections per replica. Always set it explicitly in `DATABASE_URL`:

```
...pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=20&pool_timeout=20
```

Rule: **replicas × `connection_limit` ≤ the pooler's *Pool Size*** (Supabase → Database → Settings → Connection pooling). Raising Supabase compute raises both the pool size and `max_connections`. With the database in-region, 20 connections per replica sustain several hundred locked transactions per second.

### 3.3 Photos in Supabase Storage → run 2 replicas

A Railway volume attaches to a single instance, so the `local` photo driver limits the API to **one replica** (one crash = every student briefly disconnected). Use the **`supabase` driver** ([`server/src/lib/storage.ts`](server/src/lib/storage.ts)) instead; then nothing in the API is tied to one instance:

| Concern | Replica-safe because |
| :--- | :--- |
| Sessions, answers, timers | All in PostgreSQL |
| Identity photos | Private Supabase Storage bucket, shared by all replicas |
| Background sweeper | Rows claimed with `SKIP LOCKED`; every replica may run it |
| Outage detection | Platform clock in PostgreSQL, stamped by every replica |
| Rate limits | In-memory per replica — limits become N× looser, acceptable for abuse ceilings |

Setup:
1. Supabase → **Storage → New bucket** `identity-photos`, **Public bucket: OFF**. No policies are needed (the service-role key is used server-side only).
2. Railway variables: `PHOTO_STORAGE_DRIVER=supabase`, `SUPABASE_URL=https://<project-ref>.supabase.co`, `SUPABASE_SERVICE_ROLE_KEY=<service_role key>` (Project Settings → API). The app refuses to start if either is missing.
3. Remove the Railway volume, then set **replicas = 2** (3 adds little: the API is not CPU-bound once the CDN serves static files).
4. Keep replicas × `connection_limit` ≤ the pooler pool size ([§3.2](#32-size-the-prisma-pool-against-the-supabase-pooler)), e.g. 2 × 20.

Photos captured under the `local` driver are not migrated (the database is still master-data only, so there are none). `PHOTO_STORAGE_DRIVER=disabled` remains an exam-day fallback (the capture step still verifies the camera; nothing is stored).

### 3.4 Cloudflare in front of Railway

1. Add the custom domain to Cloudflare (proxied, orange cloud) and to the Railway service; SSL/TLS mode **Full (strict)**.
2. **Cache Rules:** `/assets/*` → eligible for cache, respect origin (`immutable`, 1 year); `/mediapipe/*`, `/models/*` → eligible for cache (origin sends `s-maxage=604800`); `/api/*` → **bypass**. Do not "Cache Everything" on `/` — `index.html` must stay `no-cache` so deploys take effect.
3. **Purge** `/mediapipe/*` after upgrading `@mediapipe/tasks-vision` (those file names are not content-hashed).
4. Set `TRUST_PROXY=2` (Cloudflare → Railway edge → Node) so `req.ip` is the student's address, and `APP_ORIGIN=https://<custom-domain>` (CSRF origin check).
5. Warm the cache the day before: open the exam page once from the campus network.
6. Turn off **Bot Fight Mode / "Under Attack"** for the exam hostname — 2,000 students behind one IP look like a bot farm and would get challenge pages mid-exam.

### 3.5 Lock down Supabase's Data API

Supabase publishes every table in the `public` schema over its REST Data API, and by default grants the `anon` role access. Test Orbit never uses the Data API, but the tables include `QuestionOption.isCorrect` (answer keys), student PII and `AdminUser.passwordHash`.

* Migration [`20261004120000_supabase_revoke_data_api_grants`](prisma/migrations/20261004120000_supabase_revoke_data_api_grants/migration.sql) revokes `anon`/`authenticated` grants (applied by the normal pre-deploy `prisma migrate deploy`; no-op on plain PostgreSQL).
* Additionally, in the dashboard: **Project Settings → Data API → disable** (or remove `public` from *Exposed schemas*), and check **Advisors → Security** shows no exposed tables.
* Verify from the SQL editor — this must return no rows:
  ```sql
  SELECT table_name, grantee FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated');
  ```

---

## 4. What has been optimised (and where)

| # | Change | Status | Where |
| :--- | :--- | :--- | :--- |
| 1 | **Session-keyed API rate limit.** Per-student budget (600/min) keyed by the session cookie; anonymous traffic keyed by IP (6,000/min); a per-IP ceiling (40,000/min) on top so rotating fake cookies cannot bypass limiting. `cookieParser` runs before the limiter so the cookie is visible. | ✅ Done | [`rateLimit.ts`](server/src/middleware/rateLimit.ts), [`app.ts`](server/src/app.ts) |
| 2 | **Registration limit fit for one campus NAT.** Was 500 per IP per 15 min (student #501 got HTTP 429); now 20 per IP + registration number, with a 5,000-per-IP ceiling. | ✅ Done | [`rateLimit.ts`](server/src/middleware/rateLimit.ts) |
| 3 | **Heartbeat fast path.** One conditional `UPDATE … RETURNING` with no interactive transaction (1 round trip instead of ~6). It matches only when the locked path would change nothing (owned, `IN_PROGRESS`, before deadline + grace, heartbeat not stale); otherwise it falls back to the locked state-machine path, so expiry/interruption semantics are unchanged. A concurrent submit is waited for and the `WHERE` re-checked, so a finished session is never revived. | ✅ Done | [`assessment.service.ts`](server/src/modules/assessment/assessment.service.ts) `heartbeat()` |
| 4 | **Heartbeat 20 s → 30 s with ±15 % jitter**, chained (never overlapping). Saves and proctoring events also refresh `lastHeartbeatAt`; the default 180 s timeout still tolerates five missed beats. Keep `heartbeatTimeoutSeconds` ≥ 120 in Settings. | ✅ Done | `HEARTBEAT_INTERVAL_SECONDS`, [`AssessmentPage.tsx`](client/src/pages/assessment/AssessmentPage.tsx) |
| 5 | **Bulk scoring on finalisation.** One `UPDATE … FROM (VALUES …)` per session instead of one `UPDATE` per question (a 50-question paper: 50 round trips → 1, while holding the row lock). | ✅ Done | [`lifecycle.ts`](server/src/modules/assessment/lifecycle.ts) `finalizeSession()` |
| 6 | **Sweeper never blocks live traffic or other replicas.** Rows are claimed with `FOR UPDATE SKIP LOCKED`; a busy row is retried on the next 15 s tick. | ✅ Done | [`sweeper.ts`](server/src/jobs/sweeper.ts), `tryLockSession()` |
| 7 | **Cacheable WASM/model.** `/mediapipe/*` and `/models/*` now send `max-age=86400, s-maxage=604800` (previously `max-age=0`, i.e. revalidated by every student and not CDN-cacheable by default). | ✅ Done | [`app.ts`](server/src/app.ts) |
| 8 | **Supabase pooler + `directUrl`.** Runtime through the transaction pooler (6543), migrations through the session pooler (5432). Server tests now force `DIRECT_URL` to the test database, so `prisma migrate deploy` in the test setup can never touch production. | ✅ Done | [`schema.prisma`](prisma/schema.prisma), [`globalSetup.ts`](server/test/globalSetup.ts) |
| 9 | **Supabase Data API grants revoked.** | ✅ Migration added — deploy + dashboard step in [§3.5](#35-lock-down-supabases-data-api) | `prisma/migrations/20261004120000_…` |
| 10 | **Platform outage guard.** Every replica stamps a platform clock every 15 s (`SystemSetting` row `platform`). A gap > 60 s means *we* were down, so heartbeat silence is counted from the moment the platform recovered (and not at all while the clock is stale). Students whose heartbeats failed because of a restart, deploy or database outage keep going instead of all becoming `INTERRUPTED`. Deadlines are never extended. | ✅ Done | [`platformClock.ts`](server/src/lib/platformClock.ts), `applyTimeRules()`, [`sweeper.ts`](server/src/jobs/sweeper.ts) |
| 11 | **Bulk re-entry approval.** Admin → Re-entry: tick pending requests (selection survives paging), *Approve selected* with one reason and time adjustment; every student gets their own one-time code, shown once in a copyable list. Each request runs the single-approval rules in its own transaction, so one ineligible request never blocks the rest. ADMIN-only, max 200 per action, audited per request (`bulk: true`). Rejection stays one at a time. | ✅ Done | `POST /api/admin/reentry/bulk-approve`, [`ReentryPage.tsx`](client/src/pages/admin/ReentryPage.tsx) |
| 12 | Cloudflare CDN | ⏳ Infra step | [§3.4](#34-cloudflare-in-front-of-railway) |
| 13 | Region co-location, pool sizing | ⏳ Infra step | [§3.1](#31-put-the-api-and-the-database-in-the-same-region), [§3.2](#32-size-the-prisma-pool-against-the-supabase-pooler) |

Already correct in the original design (no change needed): answers are an idempotent `INSERT … ON CONFLICT … WHERE clientSeq < new` upsert; the client keeps one in-flight save per question with retry/backoff; `Start` is idempotent under a student row lock; settings are cached for 5 s; static `/assets` are content-hashed and immutable.

---

## 5. Configuration

Copy [`.env.example`](.env.example) to `.env`. Every variable is validated at startup ([`server/src/config/env.ts`](server/src/config/env.ts)); invalid config exits with the variable *names* only.

| Variable | Local | Railway (production) |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | `production` |
| `DATABASE_URL` | local Postgres | Supabase **transaction pooler** `:6543` + `?pgbouncer=true&connection_limit=20&pool_timeout=20` |
| `DIRECT_URL` | same as `DATABASE_URL` | Supabase **session pooler** `:5432` (no `pgbouncer` flag). **Required** — `prisma migrate deploy` in the pre-deploy step fails without it. |
| `TEST_DATABASE_URL` | a separate, disposable database (wiped by tests) | — |
| `SESSION_SECRET` | ≥ 32 random chars | ≥ 48 random bytes; never reuse the local value |
| `TRUST_PROXY` | `0` | `1` (Railway only) · `2` (Cloudflare → Railway) |
| `APP_ORIGIN` | `http://localhost:5173` | `https://<custom-domain>` |
| `PHOTO_STORAGE_DRIVER` | `local` (+ `PHOTO_STORAGE_DIR=./storage/identity-photos`) | `supabase` (recommended, allows replicas) · `local` with a volume (1 replica) · `disabled` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_STORAGE_BUCKET` | — | required for `supabase` photos; bucket defaults to `identity-photos` (private). **Server-side secret.** |
| `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` | first run only | first deploy only — delete afterwards |

Supabase connection string shapes (take the real values from *Project → Connect*; URL-encode special characters in the password, e.g. `@` → `%40`):

```env
DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=20&pool_timeout=20"
DIRECT_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

---

## 6. Request flows

### Steady state (one student)

```
Browser                         Cloudflare        Node (Express)                          PostgreSQL
  │ click option (clientSeq=n)      │                  │                                        │
  ├── POST /answers ───────────────►├─────────────────►│ resolve session cookie ───────────────►│ 1 query (+ lastSeenAt ≤ 1/min)
  │                                 │                  │ BEGIN; SELECT … FOR UPDATE (own row)   │
  │                                 │                  │ apply time rules · validate option     │
  │                                 │                  │ INSERT … ON CONFLICT WHERE seq < n     │
  │                                 │                  │ UPDATE session (lastSaved/heartbeat)   │
  │◄── {applied, savedAt} ──────────┤◄─────────────────┤ COMMIT ───────────────────────────────►│
  │ show "Saved"                    │                  │                                        │
  │                                 │                  │                                        │
  ├── POST /heartbeat (30 s ±15 %) ►├─────────────────►│ UPDATE … WHERE IN_PROGRESS AND fresh   │ 1 statement (fast path)
  │◄── {remainingMs} ───────────────┤◄─────────────────┤   RETURNING …  (else locked fallback)  │
  │ re-sync countdown (server clock)│                  │                                        │
```

### Submission

```
timer hits 0 ─► flush pending saves (≤ 4 s) ─► POST /submit
                                                 │ BEGIN; SELECT … FOR UPDATE
                                                 │ load questions + answers + answer keys (1 query)
                                                 │ score in memory (scoring.ts, pure)
                                                 │ UPDATE "SessionQuestion" … FROM (VALUES …)   ← 1 statement for the paper
                                                 │ UPDATE "AssessmentSession" (status, totals)
                                                 └ COMMIT  → idempotent: a repeated submit returns the final result

browser closed? ─► sweeper (every 15 s, SKIP LOCKED) finalises it as EXPIRED after deadline + grace
```

---

## 7. Local development & tests

```bash
npm install
cp .env.example .env            # then fill in DATABASE_URL, DIRECT_URL, SESSION_SECRET
npm run db:deploy               # apply migrations
npm run db:seed                 # reference data (domains, default settings)
npm run admin:bootstrap         # first admin (forced password change)
npm run dev                     # Vite :5173 (proxies /api) + Express :4000
```

| Command | What it does |
| :--- | :--- |
| `npm test` | shared (Zod/import parsers) + server (API integration, needs `TEST_DATABASE_URL`) + client (React Testing Library) |
| `npm run typecheck` / `npm run lint` | TypeScript across all workspaces / ESLint |
| `npm run build` | `prisma generate` + Vite client build + tsup server bundle |
| `npm run db:verify` | row counts of the database in `.env` `DATABASE_URL` |
| `npm run db:export` | JSON export to `backups/` (git-ignored) |
| `npm run db:import -- <file>` | restore master data (domains, settings, admins, questions, papers, students) into `TARGET_DATABASE_URL` / `DATABASE_URL`. Does **not** restore sessions, answers, events or audit logs — use `pg_dump`/`pg_restore` for a full copy. |

Load test before every new drive size: a k6 (or Artillery) script that registers N virtual students, completes the device check, starts, then loops *save → heartbeat* with realistic think time and submits at the end. Run it against a staging Railway service pointed at a staging Supabase project in the same regions as production, and watch p95 latency, pooler wait time and Supabase CPU.

---

## 8. Database migration status & backups

Master data was moved from the Railway PostgreSQL service to Supabase via `pg_dump` and verified with row counts (as of 2026-10-04): 421 questions, 1,596 options, 6 papers, 32 sections, 5 domains, 1 admin, 1 settings row, 6 Prisma migrations (a 7th — the Data API grants revocation — ships with this change). No student or session data existed yet.

Local copies (git-ignored, keep them in encrypted storage and delete when no longer needed): `backups/railway_live_backup.sql`, `backups/testorbit_backup_2026-10-04T13-43-29-197Z.json`.

Production backups: Supabase daily backups (Pro plan; enable PITR for drive days if budget allows) plus a manual `pg_dump --format=custom "$DIRECT_URL"` right before and right after every drive.

---

## 9. Exam-day runbook

### T − 48 h
- [ ] Supabase compute: scale to **Small** or **Medium** (more CPU, larger pool). Re-check that replicas × `connection_limit` ≤ pool size.
- [ ] Railway: service in the **same region** as Supabase; ≥ 2 vCPU / 2 GB per replica; **2 replicas** with `PHOTO_STORAGE_DRIVER=supabase` ([§3.3](#33-photos-in-supabase-storage--run-2-replicas)).
- [ ] Variables set: `DATABASE_URL` (with `connection_limit`), `DIRECT_URL`, `TRUST_PROXY`, `APP_ORIGIN`.
- [ ] Data API locked down ([§3.5](#35-lock-down-supabases-data-api)).
- [ ] Admin → **Question Papers**: every active paper shows *Ready* (enough eligible questions per section).
- [ ] Admin → **Settings**: `heartbeatTimeoutSeconds` ≥ 120 (default 180); proctoring rules reviewed.
- [ ] `pg_dump` backup; `npm run db:export`.
- [ ] Dry run with a dummy student from the campus network (also warms the CDN cache).

### T − 0 (during the drive)
- [ ] **Deploy freeze.** No deploys, no variable changes (a variable change restarts the service).
- [ ] Watch: Supabase → Reports → Database (CPU, connections) and Query Performance; Railway → Metrics (CPU, memory, 5xx); Cloudflare → Analytics (cache hit ratio should be > 95 % for `/mediapipe`).
- [ ] Keep Admin → **Re-entry** open; approve genuine interruptions promptly. For a whole lab, filter by college, tick *select all*, use **Approve selected**, and copy the code list for the invigilators.
- [ ] If Railway logs show `platform outage detected`, students were protected automatically; no re-entry approvals are needed for that outage.

### After the drive
- [ ] Admin → **Reports**: export results CSV (contains PII — store access-controlled).
- [ ] `pg_dump` backup.
- [ ] Scale Supabase compute and Railway resources back down.

---

## 10. Known risks & roadmap

| Priority | Risk / gap | Impact | Mitigation / next step |
| :--- | :--- | :--- | :--- |
| ~~P0~~ | ~~Platform outage → mass `INTERRUPTED`~~ | — | **Fixed:** platform outage guard + bulk re-entry approval ([§4](#4-what-has-been-optimised-and-where) #10, #11). |
| **P1** | **Campus network outage** (our platform healthy, the college's internet down > 180 s). | Affected students are `INTERRUPTED` — by design, their time is frozen. | Admin → Re-entry → filter by college → select all → *Approve selected*; hand out the printed code list. |
| ~~P1~~ | ~~Single replica while photos use a Railway volume~~ | — | **Fixed:** `supabase` photo driver ([§3.3](#33-photos-in-supabase-storage--run-2-replicas)) → run 2 replicas. |
| **P1** | Database region (currently Tokyo). | Latency-bound throughput ([§3.1](#31-put-the-api-and-the-database-in-the-same-region)). | Recreate in Singapore/Mumbai while the database is still master-data only. |
| **P2** | Requests that bypass Cloudflare (the `*.up.railway.app` domain) can spoof `X-Forwarded-For` when `TRUST_PROXY=2`. | IP-keyed limits can be evaded by an attacker who knows the Railway hostname. | Remove the Railway-generated public domain once the custom domain works. |
| **P2** | `saveAnswer` still takes ~8 statements under a row lock. | Fine in-region (~10 ms); first thing to optimise if load tests show pool waits. | Single-statement CTE upsert with the same guards as the heartbeat fast path. |
| **P3** | No response compression in Express. | Only matters for traffic that misses the CDN. | Cloudflare compresses at the edge; add `compression` only if serving without a CDN. |
