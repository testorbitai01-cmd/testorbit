import { env } from './config/env.js';
import { createApp } from './app.js';
import { startBackgroundJobs, stopBackgroundJobs } from './jobs/sweeper.js';
import { prisma } from './lib/prisma.js';

const app = createApp();

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`[test-orbit] API listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV}), app origin ${env.appOrigin}`);
  startBackgroundJobs();
});

async function shutdown(signal: string) {
  console.log(`[test-orbit] ${signal} received, shutting down`);
  stopBackgroundJobs();
  server.close(() => {
    prisma.$disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
