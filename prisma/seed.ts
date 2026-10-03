/**
 * Idempotent reference-data seed (safe to run on every deploy):
 *  • the four assessment domains
 *  • default system settings (only if none exist yet)
 *
 * It never creates admin accounts or passwords — see `npm run admin:bootstrap`.
 */
import { PrismaClient } from '@prisma/client';
import { DEFAULT_SETTINGS, DOMAINS } from '@test-orbit/shared';

const prisma = new PrismaClient();

async function main() {
  for (const d of DOMAINS) {
    await prisma.domain.upsert({
      where: { slug: d.slug },
      update: { name: d.name },
      create: { slug: d.slug, name: d.name },
    });
  }
  const existing = await prisma.systemSetting.findUnique({ where: { key: 'app' } });
  if (!existing) {
    await prisma.systemSetting.create({ data: { key: 'app', value: DEFAULT_SETTINGS } });
  }
  console.log(`[seed] ${DOMAINS.length} domains ensured; settings ${existing ? 'kept' : 'initialised'}`);
}

main()
  .catch((e) => {
    console.error('[seed] failed:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
