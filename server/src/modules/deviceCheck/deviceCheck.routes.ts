/**
 * Device check + identity photo.
 *
 * PRIVACY: the camera/microphone streams never leave the student's browser.
 * The only media the server ever receives is ONE still photo, uploaded after the
 * student explicitly confirms it, and only when PHOTO_STORAGE_DRIVER is enabled.
 */
import express, { Router } from 'express';
import { deviceCheckSchema } from '@test-orbit/shared';
import { badRequest, conflict } from '../../lib/errors.js';
import { sha256 } from '../../lib/crypto.js';
import { prisma } from '../../lib/prisma.js';
import { getSettings } from '../../lib/settings.js';
import { photoKey, photoStorage, sniffImage } from '../../lib/storage.js';
import { requireStudent } from '../../middleware/auth.js';
import { getStudentProfile } from '../students/student.service.js';

export const deviceCheckRouter = Router();

const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024;

async function assertNotStarted(studentId: string) {
  const count = await prisma.assessmentSession.count({ where: { studentId } });
  if (count > 0) throw conflict('The device check cannot be changed after the assessment has started', undefined, 'ASSESSMENT_ALREADY_STARTED');
}

deviceCheckRouter.post(
  '/identity-photo',
  requireStudent,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_PHOTO_BYTES }),
  async (req, res) => {
    const studentId = req.studentId!;
    await assertNotStarted(studentId);
    if (!photoStorage.enabled) {
      // Policy: photo storage is disabled — nothing is persisted.
      res.json({ stored: false, reason: 'Photo storage is disabled by the administrator' });
      return;
    }
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Upload the captured photo as image/jpeg, image/png or image/webp');
    const kind = sniffImage(body);
    if (!kind) throw badRequest('The uploaded file is not a supported image');

    const settings = await getSettings();
    const key = photoKey(studentId, kind.ext);
    await photoStorage.put(key, body);
    const now = new Date();
    const previous = await prisma.identityPhoto.findMany({ where: { studentId, deletedAt: null } });
    await prisma.$transaction([
      prisma.identityPhoto.updateMany({ where: { studentId, deletedAt: null }, data: { deletedAt: now } }),
      prisma.identityPhoto.create({
        data: {
          studentId,
          storageDriver: photoStorage.driver,
          storageKey: key,
          mimeType: kind.mime,
          sizeBytes: body.length,
          sha256: sha256(body),
          confirmedAt: now,
          retentionUntil: new Date(now.getTime() + settings.identityPhoto.retentionDays * 86_400_000),
        },
      }),
    ]);
    // A recapture replaces the earlier photo; remove the old bytes.
    await Promise.all(previous.map((p) => photoStorage.delete(p.storageKey).catch(() => undefined)));
    res.status(201).json({ stored: true });
  },
);

deviceCheckRouter.post('/device-check/complete', requireStudent, async (req, res) => {
  const studentId = req.studentId!;
  const input = deviceCheckSchema.parse(req.body);
  const settings = await getSettings();
  if (settings.identityPhoto.required && photoStorage.enabled) {
    const photo = await prisma.identityPhoto.findFirst({ where: { studentId, deletedAt: null } });
    if (!photo) throw badRequest('Capture and confirm your identity photo before continuing', undefined, 'PHOTO_REQUIRED');
  }
  const existingSession = await prisma.assessmentSession.count({ where: { studentId } });
  if (existingSession === 0) {
    await prisma.student.update({
      where: { id: studentId },
      data: {
        deviceCheckCompletedAt: new Date(),
        deviceCheckDetails: { cameraOk: input.cameraOk, microphoneOk: input.microphoneOk, userAgent: input.userAgent ?? req.get('user-agent')?.slice(0, 300) ?? null },
      },
    });
  }
  res.json(await getStudentProfile(studentId));
});
