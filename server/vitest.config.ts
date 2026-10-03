import path from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const rootEnv = loadEnv('test', path.resolve(__dirname, '..'), '');
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? rootEnv.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // Tests share one database, so run files sequentially.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      ...rootEnv,
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl ?? '',
      SESSION_SECRET: rootEnv.SESSION_SECRET || 'test-secret-test-secret-test-secret-1234',
      APP_ORIGIN: 'http://localhost:5173',
      PHOTO_STORAGE_DRIVER: 'local',
      PHOTO_STORAGE_DIR: path.resolve(__dirname, '../storage/test-photos'),
    },
  },
});
