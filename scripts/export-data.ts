import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

async function main() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
  if (!sourceUrl) {
    console.error('Error: SOURCE_DATABASE_URL or DATABASE_URL must be set.');
    console.error('Usage: SOURCE_DATABASE_URL="postgresql://..." npx tsx scripts/export-data.ts');
    process.exit(1);
  }

  console.log('Connecting to database to export data...');
  const prisma = new PrismaClient({
    datasourceUrl: sourceUrl,
    log: ['error'],
  });

  try {
    const backupDir = path.resolve(process.cwd(), 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    console.log('Fetching domains...');
    const domains = await prisma.domain.findMany();

    console.log('Fetching admin accounts and settings...');
    const adminUsers = await prisma.adminUser.findMany();
    const systemSettings = await prisma.systemSetting.findMany();

    console.log('Fetching question bank & options...');
    const questions = await prisma.question.findMany({
      include: { options: { orderBy: { position: 'asc' } } },
    });

    console.log('Fetching question papers & sections...');
    const papers = await prisma.questionPaper.findMany({
      include: { sections: { orderBy: { position: 'asc' } } },
    });

    console.log('Fetching students & education records...');
    const students = await prisma.student.findMany({
      include: {
        education: true,
        identityPhotos: true,
      },
    });

    console.log('Fetching assessment sessions & answers...');
    const sessions = await prisma.assessmentSession.findMany({
      include: {
        questions: true,
        answers: true,
        events: true,
        reentryRequests: true,
      },
    });

    console.log('Fetching audit logs...');
    const auditLogs = await prisma.adminAuditLog.findMany();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `testorbit_backup_${timestamp}.json`;
    const filepath = path.join(backupDir, filename);

    const payload = {
      exportedAt: new Date().toISOString(),
      sourceDatabaseUrl: sourceUrl.replace(/:([^:@]+)@/, ':***@'),
      stats: {
        domains: domains.length,
        adminUsers: adminUsers.length,
        systemSettings: systemSettings.length,
        questions: questions.length,
        questionOptions: questions.reduce((sum, q) => sum + q.options.length, 0),
        papers: papers.length,
        students: students.length,
        assessmentSessions: sessions.length,
        auditLogs: auditLogs.length,
      },
      data: {
        domains,
        adminUsers,
        systemSettings,
        questions,
        papers,
        students,
        sessions,
        auditLogs,
      },
    };

    fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf8');

    console.log('\n=========================================');
    console.log('       BACKUP COMPLETED SUCCESSFULLY     ');
    console.log('=========================================');
    console.log(`Saved to: ${filepath}`);
    console.log('Data Summary:');
    console.log(`  • Domains:             ${domains.length}`);
    console.log(`  • Admin Accounts:      ${adminUsers.length}`);
    console.log(`  • System Settings:     ${systemSettings.length}`);
    console.log(`  • Questions:           ${questions.length} (with ${payload.stats.questionOptions} options)`);
    console.log(`  • Question Papers:     ${papers.length}`);
    console.log(`  • Students:            ${students.length}`);
    console.log(`  • Assessment Sessions: ${sessions.length}`);
    console.log(`  • Audit Logs:          ${auditLogs.length}`);
    console.log('=========================================\n');
  } catch (error) {
    console.error('Export failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
