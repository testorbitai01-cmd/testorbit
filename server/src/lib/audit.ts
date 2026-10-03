import type { Request } from 'express';
import { Prisma, prisma, type Tx } from './prisma.js';
import { clientIp, clientUa } from './sessions.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Prisma.InputJsonValue;
}

/**
 * Append an admin audit-log entry. Pass `tx` to make the log part of the same
 * transaction as the change it describes (so neither can exist without the other).
 * Never put secrets (passwords, resume codes, tokens) in `details`.
 */
export async function audit(req: Request, entry: AuditEntry, tx: Tx = prisma): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      adminId: req.admin?.id ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      details: entry.details ?? Prisma.JsonNull,
      ipAddress: clientIp(req),
      userAgent: clientUa(req),
    },
  });
}

/** System-generated audit entry (no admin / request), e.g. scheduled photo purge. */
export async function auditSystem(entry: AuditEntry, tx: Tx = prisma): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      adminId: null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      details: entry.details ?? Prisma.JsonNull,
    },
  });
}
