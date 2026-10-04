import { PrismaClient } from '@prisma/client';

// Credentials come from the environment only (never hard-code a connection string here).
const poolUrl = process.env.DATABASE_URL;
if (!poolUrl) {
  console.error('Error: DATABASE_URL must be set (it is read from .env by `npm run db:verify`).');
  process.exit(1);
}

const prisma = new PrismaClient({
  datasourceUrl: poolUrl,
});

async function main() {
  console.log(`Testing database connection (${new URL(poolUrl!).host})...`);
  const domains = await prisma.domain.count();
  const questions = await prisma.question.count();
  const options = await prisma.questionOption.count();
  const papers = await prisma.questionPaper.count();
  const sections = await prisma.paperSection.count();
  const admins = await prisma.adminUser.count();
  const settings = await prisma.systemSetting.count();

  console.log('\n=============================================');
  console.log('  DATABASE VERIFICATION                      ');
  console.log('=============================================');
  console.log(`  • Questions:        ${questions}`);
  console.log(`  • Question Options: ${options}`);
  console.log(`  • Question Papers:  ${papers}`);
  console.log(`  • Paper Sections:   ${sections}`);
  console.log(`  • Domains:          ${domains}`);
  console.log(`  • Admin Users:      ${admins}`);
  console.log(`  • System Settings:  ${settings}`);
  console.log('=============================================\n');
}

main()
  .catch((e) => {
    console.error('Verification failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
