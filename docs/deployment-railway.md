# Deploying to Railway

Target topology: **one web service** (this repository) + **one Railway PostgreSQL service** (with its managed volume) + a **Railway Volume** on the web service for identity photos. Railway terminates HTTPS, which the browser requires for camera/microphone access.

> Status: the production build and the start command were verified locally (`npm run build && NODE_ENV=production npm start`, full browser flow). A deployment to an actual Railway project has **not** been performed from this workspace — follow the checklist below and verify `/api/health` after your first deploy.

## 1. Create the services

1. New project → **Deploy from GitHub repo** (push this repository first) → select it. Railway reads `railway.json`:
   * build: `npm run build` (Railpack, Node version from `engines` — Node 22 recommended)
   * pre-deploy: `npm run railway:release` → `prisma migrate deploy` + reference seed (domains, default settings) + `admin:bootstrap` (no-op once an admin exists)
   * start: `npm start` (listens on `$PORT`, `0.0.0.0`)
   * health check: `GET /api/health`
2. **+ New → Database → PostgreSQL**.
3. On the web service: **Settings → Networking → Generate Domain** (HTTPS).
4. On the web service: **+ New Volume**, mount path `/data` (identity photos).

Do not set `NPM_CONFIG_PRODUCTION=true` / `--omit=dev` for the build: the client build needs its dev dependencies (Vite, Tailwind).

## 2. Variables (web service)

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (private network; no SSL parameters needed). If you ever use the public proxy URL instead, append `?sslmode=require`. |
| `SESSION_SECRET` | 48+ random bytes, e.g. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `TRUST_PROXY` | `1` (correct client IPs for rate limiting/audit behind Railway's proxy) |
| `APP_ORIGIN` | optional — defaults to `https://${RAILWAY_PUBLIC_DOMAIN}`; set it if you use a custom domain |
| `ADMIN_BOOTSTRAP_EMAIL` | `admin@gradtwin.com` |
| `ADMIN_BOOTSTRAP_PASSWORD` | strong temporary password (first deploy only; remove afterwards) |
| `PHOTO_STORAGE_DRIVER` | `local` (or `disabled` to store no photos) |
| `PHOTO_STORAGE_DIR` | `/data/identity-photos` |

`PORT` and `RAILWAY_PUBLIC_DOMAIN` are provided by Railway.

## 3. First deploy

1. Deploy. Watch the pre-deploy log for `Applying migration …`, `[seed] 4 domains ensured`, `[bootstrap] Created admin …`.
2. Open `https://<your-domain>/api/health` → `{"status":"ok","database":"ok"}`.
3. Sign in at `/admin/login` with the bootstrap credentials; you must set a new password.
4. Delete `ADMIN_BOOTSTRAP_PASSWORD` from the variables.
5. Import questions, create and activate one paper per domain, and do a test run with a dummy student before the drive.

## 4. Schema changes

Create migrations locally with `npm run db:migrate -- --name <change>`, commit `prisma/migrations`, and deploy; the pre-deploy step runs `prisma migrate deploy`, which only applies pending migrations and never resets data. Never run `prisma migrate reset` or `db push --force-reset` against production.

## 5. Scaling note

The app is designed for **one replica**: background jobs, in-memory rate limits and the local photo volume assume a single instance. A campus drive of several hundred concurrent students is well within one instance; if you need more replicas, move rate limiting to a shared store, run the sweeper on one instance only, and switch photos to object storage (implement another `PhotoStorage` driver in `server/src/lib/storage.ts`).

## 6. Backups & restore

* **Database:** enable Railway PostgreSQL backups (service → Backups) and keep a schedule that covers drive days. For an off-platform copy: `pg_dump --format=custom "$DATABASE_PUBLIC_URL" > test-orbit-$(date +%F).dump`. Restore into a fresh database with `pg_restore --no-owner --dbname "$TARGET_URL" test-orbit-YYYY-MM-DD.dump`, then point `DATABASE_URL` at it and redeploy.
* **Photos:** the `/data` volume is separate from the database; back it up (Railway volume backups) on the same schedule, or accept that photos are short-lived verification data governed by the retention setting. The database only references photos by key, so a database restore without the volume simply shows "photo no longer available".
* Test a restore before the recruitment season; take a manual backup right before and after each drive.
* Exported CSV reports contain personal data — store them in access-controlled locations and delete them when no longer needed.
