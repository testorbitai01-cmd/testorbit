import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Walk up from the working directory to the repository root (the folder containing prisma/schema.prisma). */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'prisma', 'schema.prisma'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot();

// Load `.env` from the repo root for local development. Existing environment
// variables (e.g. Railway service variables, test overrides) always win.
const envFile = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envFile) && process.env.NODE_ENV !== 'test') {
  process.loadEnvFile(envFile);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  APP_ORIGIN: z.url().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PHOTO_STORAGE_DRIVER: z.enum(['local', 'supabase', 'disabled']).default('local'),
  PHOTO_STORAGE_DIR: z.string().default('./storage/identity-photos'),
  // Supabase Storage (PHOTO_STORAGE_DRIVER=supabase). Server-side only — the service-role key
  // bypasses Storage policies and must never reach the browser.
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/, 'lowercase letters, digits, . _ -').default('identity-photos'),
}).superRefine((v, ctx) => {
  if (v.PHOTO_STORAGE_DRIVER !== 'supabase') return;
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const) {
    if (!v[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when PHOTO_STORAGE_DRIVER=supabase' });
  }
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Print variable names only — never values.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const raw = parsed.data;
const appOrigin =
  raw.APP_ORIGIN ?? (raw.RAILWAY_PUBLIC_DOMAIN ? `https://${raw.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${raw.PORT}`);

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  appOrigin: new URL(appOrigin).origin,
  photoStorageDir: path.resolve(REPO_ROOT, raw.PHOTO_STORAGE_DIR),
  clientDistDir: path.join(REPO_ROOT, 'client', 'dist'),
};
