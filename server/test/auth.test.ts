import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { adminAgent, createAdmin, newAgent, post, registerStudent, resetDb } from './helpers.js';

beforeEach(resetDb);

describe('admin authentication', () => {
  it('rejects bad credentials with a generic message and accepts good ones', async () => {
    await createAdmin();
    const agent = newAgent();
    const bad = await post(agent, '/api/auth/admin/login', { email: 'admin@gradtwin.com', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Invalid email or password');
    const unknown = await post(agent, '/api/auth/admin/login', { email: 'nobody@gradtwin.com', password: 'wrong-password' });
    expect(unknown.body.error.message).toBe('Invalid email or password');

    const ok = await post(agent, '/api/auth/admin/login', { email: 'admin@gradtwin.com', password: 'Sup3rSecretPass' });
    expect(ok.status).toBe(200);
    expect(ok.body.admin).not.toHaveProperty('passwordHash');
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await agent.get('/api/auth/admin/me')).status).toBe(200);
  });

  it('locks the account after repeated failures', async () => {
    await createAdmin();
    const agent = newAgent();
    for (let i = 0; i < 10; i++) await post(agent, '/api/auth/admin/login', { email: 'admin@gradtwin.com', password: 'nope' });
    const locked = await post(agent, '/api/auth/admin/login', { email: 'admin@gradtwin.com', password: 'Sup3rSecretPass' });
    expect(locked.status).toBe(429);
  });

  it('forces the bootstrap password to be changed before administration', async () => {
    await createAdmin({ mustChangePassword: true });
    const agent = newAgent();
    await post(agent, '/api/auth/admin/login', { email: 'admin@gradtwin.com', password: 'Sup3rSecretPass' });
    const blocked = await agent.get('/api/admin/dashboard');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const weak = await post(agent, '/api/auth/admin/change-password', { currentPassword: 'Sup3rSecretPass', newPassword: 'short', confirmPassword: 'short' });
    expect(weak.status).toBe(400);
    const changed = await post(agent, '/api/auth/admin/change-password', {
      currentPassword: 'Sup3rSecretPass',
      newPassword: 'An0therStrongPass',
      confirmPassword: 'An0therStrongPass',
    });
    expect(changed.status).toBe(200);
    expect((await agent.get('/api/admin/dashboard')).status).toBe(200);
    expect(await prisma.adminAuditLog.count({ where: { action: 'ADMIN_PASSWORD_CHANGED' } })).toBe(1);
  });

  it('logs out and invalidates the server-side session', async () => {
    const agent = await adminAgent();
    expect((await post(agent, '/api/auth/admin/logout')).status).toBe(204);
    expect((await agent.get('/api/admin/dashboard')).status).toBe(401);
    expect(await prisma.adminSession.count()).toBe(0);
  });
});

describe('authorization', () => {
  it('rejects anonymous and student sessions on every admin endpoint', async () => {
    const anon = newAgent();
    const student = newAgent();
    await registerStudent(student);
    for (const url of ['/api/admin/dashboard', '/api/admin/students', '/api/admin/questions', '/api/admin/papers', '/api/admin/reentry', '/api/admin/audit-logs', '/api/admin/reports']) {
      expect((await anon.get(url)).status, url).toBe(401);
      expect((await student.get(url)).status, url).toBe(401);
    }
  });

  it('limits reviewers to read + coding evaluation', async () => {
    const reviewer = await adminAgent('REVIEWER');
    expect((await reviewer.get('/api/admin/students')).status).toBe(200);
    expect((await reviewer.get('/api/admin/questions')).status).toBe(403);
    expect((await reviewer.get('/api/admin/settings')).status).toBe(403);
    expect((await reviewer.get('/api/admin/reports/export.csv')).status).toBe(403);
  });

  it('requires the CSRF header on state-changing requests', async () => {
    await createAdmin();
    const agent = newAgent();
    const res = await agent.post('/api/auth/admin/login').send({ email: 'admin@gradtwin.com', password: 'Sup3rSecretPass' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
    const foreign = await agent
      .post('/api/auth/admin/login')
      .set('x-test-orbit-request', '1')
      .set('Origin', 'https://evil.example')
      .send({ email: 'admin@gradtwin.com', password: 'Sup3rSecretPass' });
    expect(foreign.status).toBe(403);
  });

  it('issues a new session token on every login (no fixation)', async () => {
    await createAdmin();
    const agent = newAgent();
    await post(agent, '/api/auth/admin/login', { email: 'admin@gradtwin.com', password: 'Sup3rSecretPass' });
    const first = await prisma.adminSession.findMany();
    await post(agent, '/api/auth/admin/login', { email: 'admin@gradtwin.com', password: 'Sup3rSecretPass' });
    const second = await prisma.adminSession.findMany();
    expect(second).toHaveLength(1);
    expect(second[0]!.tokenHash).not.toBe(first[0]!.tokenHash);
  });

  it('never stores raw tokens', async () => {
    await adminAgent();
    const s = await prisma.adminSession.findFirstOrThrow();
    expect(s.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
