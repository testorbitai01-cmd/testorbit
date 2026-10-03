import { Router } from 'express';
import { auditLogQuerySchema } from '@test-orbit/shared';
import { Prisma, prisma } from '../../lib/prisma.js';

export const auditRouter = Router();

auditRouter.get('/', async (req, res) => {
  const q = auditLogQuerySchema.parse(req.query);
  const createdAt: Prisma.DateTimeFilter = {};
  if (q.from) createdAt.gte = new Date(`${q.from}T00:00:00.000Z`);
  if (q.to) createdAt.lte = new Date(`${q.to}T23:59:59.999Z`);
  const where: Prisma.AdminAuditLogWhereInput = {
    ...(q.action ? { action: q.action } : {}),
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.adminId ? { adminId: q.adminId } : {}),
    ...(q.from || q.to ? { createdAt } : {}),
  };
  const [total, items, actions] = await Promise.all([
    prisma.adminAuditLog.count({ where }),
    prisma.adminAuditLog.findMany({
      where,
      include: { admin: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.adminAuditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
  ]);
  res.json({
    items: items.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      details: a.details,
      admin: a.admin,
      ipAddress: a.ipAddress,
      createdAt: a.createdAt,
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
    actions: actions.map((a) => a.action),
  });
});
