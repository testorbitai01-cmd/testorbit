import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { completeDeviceCheck, newAgent, patch, post, registerStudent, registrationPayload, resetDb, TINY_JPEG } from './helpers.js';
import { CSRF_HEADER } from '@test-orbit/shared';

beforeEach(resetDb);

describe('student registration', () => {
  it('validates input and returns field errors', async () => {
    const res = await post(newAgent(), '/api/students/register', { ...registrationPayload(), collegeEmail: 'bad', mobileNumber: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.fieldErrors).toHaveProperty('collegeEmail');
    expect(res.body.error.details.fieldErrors).toHaveProperty('mobileNumber');
  });

  it('persists the student with education records and starts a student session', async () => {
    const agent = newAgent();
    const { student } = await registerStudent(agent, { registrationNumber: 'abc123' });
    expect(student.registrationNumber).toBe('ABC123');
    const records = await prisma.educationRecord.findMany({ where: { studentId: student.id } });
    expect(records.map((r) => r.level).sort()).toEqual(['HSC', 'SSC', 'UG']);
    const me = await agent.get('/api/students/me');
    expect(me.status).toBe(200);
    expect(me.body.nextStep).toBe('device-check');
  });

  it('rejects duplicates by registration number, mobile or email without overwriting', async () => {
    const first = registrationPayload();
    await post(newAgent(), '/api/students/register', first);
    for (const dup of [
      { registrationNumber: first.registrationNumber },
      { mobileNumber: first.mobileNumber },
      { personalEmail: first.collegeEmail },
    ]) {
      const res = await post(newAgent(), '/api/students/register', { ...registrationPayload(), ...dup });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_REGISTRATION');
    }
    expect(await prisma.student.count()).toBe(1);
    const stored = await prisma.student.findFirstOrThrow();
    expect(stored.fullName).toBe(first.fullName);
  });

  it('handles concurrent duplicate submissions safely', async () => {
    const payload = registrationPayload();
    const results = await Promise.all([1, 2, 3].map(() => post(newAgent(), '/api/students/register', payload)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it('lets a returning student sign in only before starting', async () => {
    const payload = registrationPayload();
    await post(newAgent(), '/api/students/register', payload);
    const agent = newAgent();
    const wrong = await post(agent, '/api/students/sign-in', { registrationNumber: payload.registrationNumber, mobileNumber: '9000000000' });
    expect(wrong.status).toBe(401);
    const ok = await post(agent, '/api/students/sign-in', { registrationNumber: payload.registrationNumber, mobileNumber: payload.mobileNumber });
    expect(ok.status).toBe(200);
  });

  it('allows changing domain before the assessment starts', async () => {
    const agent = newAgent();
    await registerStudent(agent);
    const res = await patch(agent, '/api/students/me/domain', { domainSlug: 'full-stack-java' });
    expect(res.status).toBe(200);
    expect(res.body.student.domain.slug).toBe('full-stack-java');
  });
});

describe('device check & identity photo', () => {
  it('requires a confirmed photo before completing the device check', async () => {
    const agent = newAgent();
    await registerStudent(agent);
    const early = await post(agent, '/api/device-check/complete', { cameraOk: true, microphoneOk: true });
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('PHOTO_REQUIRED');
    await completeDeviceCheck(agent);
    const me = await agent.get('/api/students/me');
    expect(me.body.deviceCheck).toMatchObject({ completed: true, photoCaptured: true });
    expect(me.body.nextStep).toBe('instructions');
  });

  it('rejects non-image uploads and stores only a storage reference in the database', async () => {
    const agent = newAgent();
    const { student } = await registerStudent(agent);
    const bad = await agent.post('/api/identity-photo').set(CSRF_HEADER, '1').set('Content-Type', 'image/jpeg').send(Buffer.from('not an image'));
    expect(bad.status).toBe(400);
    await completeDeviceCheck(agent);
    const photo = await prisma.identityPhoto.findFirstOrThrow({ where: { studentId: student.id } });
    expect(photo.storageKey).toMatch(new RegExp(`^${student.id}/[a-f0-9-]+\\.jpg$`));
    expect(photo.sizeBytes).toBe(TINY_JPEG.length);
    expect(photo.retentionUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it('requires both camera and microphone checks', async () => {
    const agent = newAgent();
    await registerStudent(agent);
    const res = await post(agent, '/api/device-check/complete', { cameraOk: true, microphoneOk: false });
    expect(res.status).toBe(400);
  });
});
