import { execSync } from 'node:child_process';
import path from 'node:path';
import { loadEnv } from 'vite';

/** Apply migrations to the dedicated test database once before the suite runs. */
export default function setup() {
  const root = path.resolve(__dirname, '../..');
  const env = loadEnv('test', root, '');
  const url = process.env.TEST_DATABASE_URL ?? env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set (see .env.example) — tests wipe this database.');
  if (url === (process.env.DATABASE_URL ?? env.DATABASE_URL)) {
    throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL — tests wipe this database.');
  }
  // `prisma migrate` connects through DIRECT_URL (schema.prisma `directUrl`), so it must point at the
  // test database too — otherwise the value from .env would run the migrations against production.
  execSync('npx prisma migrate deploy', { cwd: root, env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, stdio: 'pipe' });
}
