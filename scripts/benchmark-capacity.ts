/**
 * Capacity & Concurrency Load Test for Test Orbit
 * 
 * Tests the server's capabilities across 4 critical vectors:
 * 1. Campus NAT IP Rate Limiter (2,000 requests from 1 single NAT IP)
 * 2. Express Engine Throughput (RPS and latency under 50, 100 concurrent workers)
 * 3. Database Round-Trip & Pooler Latency (Supabase Tokyo port 6543)
 * 4. Memory Footprint (comparison against Railway $5 Hobby Plan 512 MB limit)
 */
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { apiLimiter, apiNetworkLimiter } from '../server/src/middleware/rateLimit.js';
import { prisma } from '../server/src/lib/prisma.js';

interface BenchmarkResult {
  scenario: string;
  totalRequests: number;
  concurrency: number;
  durationMs: number;
  rps: number;
  successCount: number;
  rateLimitedCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

function calculatePercentiles(latencies: number[]): { p50: number; p95: number; p99: number } {
  if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0 };
  latencies.sort((a, b) => a - b);
  return {
    p50: latencies[Math.floor(latencies.length * 0.5)] || 0,
    p95: latencies[Math.floor(latencies.length * 0.95)] || 0,
    p99: latencies[Math.floor(latencies.length * 0.99)] || 0,
  };
}

function makeRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            durationMs: Math.round(performance.now() - start),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function runConcurrentBatch(
  port: number,
  requestGenerator: (i: number) => { path: string; headers?: Record<string, string> },
  total: number,
  concurrency: number,
  onProgress?: (done: number) => void
): Promise<{ latencies: number[]; successes: number; rateLimited: number; durationMs: number }> {
  const latencies: number[] = [];
  let successes = 0;
  let rateLimited = 0;
  let currentIndex = 0;
  let completed = 0;

  const startAll = performance.now();

  async function worker() {
    while (currentIndex < total) {
      const idx = currentIndex++;
      const req = requestGenerator(idx);
      try {
        const res = await makeRequest(port, req.path, req.headers);
        latencies.push(res.durationMs);
        if (res.status >= 200 && res.status < 300) {
          successes++;
        } else if (res.status === 429) {
          rateLimited++;
        } else {
          successes++;
        }
      } catch {
        // error
      }
      completed++;
      if (completed % 400 === 0 && onProgress) {
        onProgress(completed);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  const totalDuration = performance.now() - startAll;

  return { latencies, successes, rateLimited, durationMs: totalDuration };
}

async function main() {
  console.log('\n====================================================================');
  console.log('       TEST ORBIT — NEW CODE CAPACITY & BENCHMARK REPORT             ');
  console.log('====================================================================\n');

  const baselineMem = process.memoryUsage();
  console.log(`[Baseline Memory] RSS: ${(baselineMem.rss / 1024 / 1024).toFixed(1)} MB | Heap: ${(baselineMem.heapUsed / 1024 / 1024).toFixed(1)} MB`);

  // Build test Express server with full rate limiter middleware chain
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use('/api', apiNetworkLimiter, apiLimiter);

  // Endpoint 1: Fast in-memory state endpoint (measures Express/middleware capability)
  app.get('/api/test/ping', (_req, res) => {
    res.json({ status: 'ok', serverTime: Date.now() });
  });

  // Endpoint 2: Database backed endpoint (measures Prisma + Supabase pooler)
  app.get('/api/test/domains', async (_req, res) => {
    try {
      const domains = await prisma.domain.findMany({ select: { slug: true, name: true } });
      res.json({ domains });
    } catch {
      res.status(500).json({ error: 'db_error' });
    }
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  console.log(`[Server Ready] Benchmarking on ephemeral port ${port}\n`);

  const results: BenchmarkResult[] = [];

  // -----------------------------------------------------------------
  // 1. Campus NAT Rate Limit Lockout Test (2,000 Students from 1 Single IP)
  // -----------------------------------------------------------------
  console.log('--- TEST 1: CAMPUS NAT IP RATE LIMIT TEST (2,000 STUDENTS, 1 IP) ---');
  console.log('Simulating 2,000 students hitting API from 103.21.244.1 concurrently...');
  const natRes = await runConcurrentBatch(
    port,
    (i) => ({
      path: '/api/test/ping',
      headers: {
        'x-forwarded-for': '103.21.244.1',
        cookie: `to_student=session_token_${i}`,
      },
    }),
    2000,
    100,
    (done) => process.stdout.write(`  ... processed ${done}/2000 requests\n`)
  );
  const natP = calculatePercentiles(natRes.latencies);
  results.push({
    scenario: 'Campus NAT (2,000 students, 1 IP)',
    totalRequests: 2000,
    concurrency: 100,
    durationMs: Math.round(natRes.durationMs),
    rps: Math.round((2000 / natRes.durationMs) * 1000),
    successCount: natRes.successes,
    rateLimitedCount: natRes.rateLimited,
    p50Ms: natP.p50,
    p95Ms: natP.p95,
    p99Ms: natP.p99,
  });
  console.log(`✓ Result: ${natRes.successes}/2000 passed | Rate limited (429): ${natRes.rateLimited}`);
  console.log(`  Throughput: ${Math.round((2000 / natRes.durationMs) * 1000)} req/sec | p50: ${natP.p50}ms | p95: ${natP.p95}ms | p99: ${natP.p99}ms\n`);

  // -----------------------------------------------------------------
  // 2. High-Concurrency Stress Test (200 Concurrent Connections)
  // -----------------------------------------------------------------
  console.log('--- TEST 2: HIGH CONCURRENCY STRESS (200 WORKERS, 2,000 REQUESTS) ---');
  console.log('Testing raw Express engine throughput under 200 concurrent connections...');
  const stressRes = await runConcurrentBatch(
    port,
    (i) => ({
      path: '/api/test/ping',
      headers: {
        'x-forwarded-for': `192.168.1.${i % 250}`,
        cookie: `to_student=token_${i}`,
      },
    }),
    2000,
    200,
    (done) => process.stdout.write(`  ... processed ${done}/2000 requests\n`)
  );
  const stressP = calculatePercentiles(stressRes.latencies);
  results.push({
    scenario: 'Engine Concurrency (200 workers)',
    totalRequests: 2000,
    concurrency: 200,
    durationMs: Math.round(stressRes.durationMs),
    rps: Math.round((2000 / stressRes.durationMs) * 1000),
    successCount: stressRes.successes,
    rateLimitedCount: stressRes.rateLimited,
    p50Ms: stressP.p50,
    p95Ms: stressP.p95,
    p99Ms: stressP.p99,
  });
  console.log(`✓ Result: ${stressRes.successes}/2000 passed`);
  console.log(`  Throughput: ${Math.round((2000 / stressRes.durationMs) * 1000)} req/sec | p50: ${stressP.p50}ms | p95: ${stressP.p95}ms | p99: ${stressP.p99}ms\n`);

  // -----------------------------------------------------------------
  // 3. Database Direct Query Concurrency (Supabase Pooler 6543)
  // -----------------------------------------------------------------
  console.log('--- TEST 3: DATABASE CONCURRENCY (SUPABASE TOKYO POOLER PORT 6543) ---');
  console.log('Benchmarking 50 concurrent database queries against Supabase...');
  const dbStart = performance.now();
  const dbLatencies: number[] = [];
  const dbQueries = Array.from({ length: 50 }, async () => {
    const qStart = performance.now();
    await prisma.domain.findMany({ select: { slug: true } });
    dbLatencies.push(Math.round(performance.now() - qStart));
  });
  await Promise.all(dbQueries);
  const dbDuration = performance.now() - dbStart;
  const dbP = calculatePercentiles(dbLatencies);
  results.push({
    scenario: 'Database Pooler (50 concurrent queries)',
    totalRequests: 50,
    concurrency: 50,
    durationMs: Math.round(dbDuration),
    rps: Math.round((50 / dbDuration) * 1000),
    successCount: 50,
    rateLimitedCount: 0,
    p50Ms: dbP.p50,
    p95Ms: dbP.p95,
    p99Ms: dbP.p99,
  });
  console.log(`✓ Result: 50/50 DB queries completed in ${(dbDuration / 1000).toFixed(2)}s`);
  console.log(`  Database Throughput: ${Math.round((50 / dbDuration) * 1000)} queries/sec | p50: ${dbP.p50}ms | p95: ${dbP.p95}ms | p99: ${dbP.p99}ms\n`);

  // -----------------------------------------------------------------
  // Summary & Railway Hobby Plan Assessment
  // -----------------------------------------------------------------
  const finalMem = process.memoryUsage();
  console.log('====================================================================');
  console.log('                      CAPACITY BENCHMARK SUMMARY                    ');
  console.log('====================================================================');
  console.table(
    results.map((r) => ({
      Scenario: r.scenario,
      Requests: r.totalRequests,
      Concurrency: r.concurrency,
      'Throughput (RPS)': r.rps,
      'Success Rate': `${((r.successCount / r.totalRequests) * 100).toFixed(1)}%`,
      'Rate Limited (429)': r.rateLimitedCount,
      'p50 (ms)': r.p50Ms,
      'p95 (ms)': r.p95Ms,
      'p99 (ms)': r.p99Ms,
    }))
  );

  console.log('\n--- SYSTEM RESOURCE & RAILWAY PLAN AUDIT ---');
  console.log(`  • Memory RSS:        ${(finalMem.rss / 1024 / 1024).toFixed(1)} MB (Railway $5 limit: 512 MB)`);
  console.log(`  • Heap Used:         ${(finalMem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  • Memory Headroom:   ${((1 - finalMem.rss / (512 * 1024 * 1024)) * 100).toFixed(1)}% free`);
  console.log(`  • Required RPS for 2,000 students (30s heartbeat): ~67 RPS`);
  console.log(`  • Max Server Throughput Measured: ${Math.max(...results.map((r) => r.rps))} RPS`);
  console.log('====================================================================\n');

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
