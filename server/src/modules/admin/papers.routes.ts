import { Router } from 'express';
import { paperInputSchema } from '@test-orbit/shared';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';
import { InsufficientPoolError } from '../assessment/assignment.js';
import { unprocessable } from '../../lib/errors.js';
import { createPaper, deletePaper, getPaper, listPapers, samplePaperDraw, serializePaper, setPaperActive, updatePaper } from './papers.service.js';

export const papersRouter = Router();

const idParam = z.object({ id: z.string().min(1).max(64) });

papersRouter.get('/', async (_req, res) => {
  res.json({ items: await listPapers() });
});

papersRouter.get('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(await serializePaper(await getPaper(id)));
});

papersRouter.post('/', async (req, res) => {
  const data = paperInputSchema.parse(req.body);
  const paper = await prisma.$transaction(
    async (tx) => {
      const p = await createPaper(data, req.admin!.id, tx);
      await audit(req, { action: 'PAPER_CREATED', entityType: 'QuestionPaper', entityId: p.id, details: { name: p.name, domain: data.domainSlug } }, tx);
      return p;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  res.status(201).json(await serializePaper(paper));
});

papersRouter.put('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const data = paperInputSchema.parse(req.body);
  const paper = await prisma.$transaction(
    async (tx) => {
      const p = await updatePaper(id, data, tx);
      await audit(
        req,
        {
          action: 'PAPER_UPDATED',
          entityType: 'QuestionPaper',
          entityId: id,
          details: { name: data.name, durationMinutes: data.durationMinutes, sections: data.sections.map((s) => `${s.key}:${s.questionCount}`).join(',') },
        },
        tx,
      );
      return p;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  res.json(await serializePaper(paper));
});

papersRouter.patch('/:id/active', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
  const { paper, deactivated } = await prisma.$transaction(
    async (tx) => {
      const r = await setPaperActive(id, isActive, tx);
      await audit(
        req,
        { action: isActive ? 'PAPER_ACTIVATED' : 'PAPER_DEACTIVATED', entityType: 'QuestionPaper', entityId: id, details: { deactivatedPapers: r.deactivated.map((d) => d.id) } },
        tx,
      );
      return r;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  res.json({ paper: await serializePaper(paper), deactivated });
});

papersRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const paper = await deletePaper(id);
  await audit(req, { action: 'PAPER_DELETED', entityType: 'QuestionPaper', entityId: id, details: { name: paper.name } });
  res.status(204).end();
});

papersRouter.get('/:id/sample', async (req, res) => {
  const { id } = idParam.parse(req.params);
  try {
    res.json({ questions: await samplePaperDraw(id) });
  } catch (e) {
    if (e instanceof InsufficientPoolError) throw unprocessable('Not enough active questions for a sample draw', { shortfalls: e.shortfalls }, 'INSUFFICIENT_QUESTIONS');
    throw e;
  }
});
