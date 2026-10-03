import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  log: env.isProduction ? ['error'] : ['warn', 'error'],
});

export type Tx = Prisma.TransactionClient;
export { Prisma };

/** Decimal | number | null → number | null (marks are DECIMAL(6,2) in the database). */
export function num(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : value.toNumber();
}

/** Like num() but defaults null to 0. */
export function num0(value: Prisma.Decimal | number | null | undefined): number {
  return num(value) ?? 0;
}
