import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';

async function main() {
  const targetUrl = process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL;
  if (!targetUrl) {
    console.error('Error: TARGET_DATABASE_URL or DATABASE_URL must be set.');
    console.error('Usage: TARGET_DATABASE_URL="postgresql://..." npx tsx scripts/import-data.ts [optional-backup-file.json]');
    process.exit(1);
  }

  const backupDir = path.resolve(process.cwd(), 'backups');
  let backupFile = process.argv[2];

  if (!backupFile) {
    if (!fs.existsSync(backupDir)) {
      console.error('Error: backups/ folder does not exist. Run export-data.ts first.');
      process.exit(1);
    }
    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json')).sort().reverse();
    if (files.length === 0) {
      console.error('Error: No .json backup files found in backups/');
      process.exit(1);
    }
    backupFile = path.join(backupDir, files[0]!);
  } else if (!path.isAbsolute(backupFile)) {
    backupFile = path.resolve(process.cwd(), backupFile);
  }

  if (!fs.existsSync(backupFile)) {
    console.error(`Error: Backup file not found at ${backupFile}`);
    process.exit(1);
  }

  console.log(`Reading backup file: ${backupFile}`);
  const content = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  const { data } = content;

  console.log('Connecting to target database (Supabase / Postgres)...');
  const prisma = new PrismaClient({
    datasourceUrl: targetUrl,
    log: ['error'],
  });

  try {
    console.log('Restoring Domains...');
    for (const d of data.domains) {
      await prisma.domain.upsert({
        where: { id: d.id },
        update: { name: d.name, slug: d.slug, isActive: d.isActive },
        create: { id: d.id, name: d.name, slug: d.slug, isActive: d.isActive, createdAt: new Date(d.createdAt), updatedAt: new Date(d.updatedAt) },
      });
    }

    console.log('Restoring System Settings...');
    for (const s of data.systemSettings) {
      await prisma.systemSetting.upsert({
        where: { key: s.key },
        update: { value: s.value, updatedById: s.updatedById },
        create: { key: s.key, value: s.value, updatedById: s.updatedById, updatedAt: new Date(s.updatedAt) },
      });
    }

    console.log('Restoring Admin Accounts...');
    for (const a of data.adminUsers) {
      await prisma.adminUser.upsert({
        where: { id: a.id },
        update: {
          email: a.email,
          name: a.name,
          passwordHash: a.passwordHash,
          role: a.role,
          isActive: a.isActive,
          mustChangePassword: a.mustChangePassword,
        },
        create: {
          id: a.id,
          email: a.email,
          name: a.name,
          passwordHash: a.passwordHash,
          role: a.role,
          isActive: a.isActive,
          mustChangePassword: a.mustChangePassword,
          failedLoginCount: a.failedLoginCount,
          lockedUntil: a.lockedUntil ? new Date(a.lockedUntil) : null,
          lastLoginAt: a.lastLoginAt ? new Date(a.lastLoginAt) : null,
          passwordChangedAt: a.passwordChangedAt ? new Date(a.passwordChangedAt) : null,
          createdAt: new Date(a.createdAt),
          updatedAt: new Date(a.updatedAt),
        },
      });
    }

    console.log('Restoring Questions & Options...');
    for (const q of data.questions) {
      await prisma.question.upsert({
        where: { id: q.id },
        update: {
          text: q.text,
          section: q.section,
          type: q.type,
          marks: new Prisma.Decimal(q.marks),
          negativeMarks: new Prisma.Decimal(q.negativeMarks),
          difficulty: q.difficulty,
          explanation: q.explanation,
          isActive: q.isActive,
          externalRef: q.externalRef,
          contentHash: q.contentHash,
        },
        create: {
          id: q.id,
          domainId: q.domainId,
          section: q.section,
          type: q.type,
          text: q.text,
          marks: new Prisma.Decimal(q.marks),
          negativeMarks: new Prisma.Decimal(q.negativeMarks),
          difficulty: q.difficulty,
          explanation: q.explanation,
          isActive: q.isActive,
          externalRef: q.externalRef,
          archivedAt: q.archivedAt ? new Date(q.archivedAt) : null,
          contentHash: q.contentHash,
          createdById: q.createdById,
          createdAt: new Date(q.createdAt),
          updatedAt: new Date(q.updatedAt),
        },
      });

      if (q.options && q.options.length > 0) {
        for (const opt of q.options) {
          await prisma.questionOption.upsert({
            where: { id: opt.id },
            update: { text: opt.text, isCorrect: opt.isCorrect, position: opt.position },
            create: {
              id: opt.id,
              questionId: q.id,
              text: opt.text,
              isCorrect: opt.isCorrect,
              position: opt.position,
              createdAt: new Date(opt.createdAt),
              updatedAt: new Date(opt.updatedAt),
            },
          });
        }
      }
    }

    console.log('Restoring Question Papers & Sections...');
    for (const p of data.papers) {
      await prisma.questionPaper.upsert({
        where: { id: p.id },
        update: {
          name: p.name,
          description: p.description,
          durationMinutes: p.durationMinutes,
          shuffleOptions: p.shuffleOptions,
          negativeMarkingEnabled: p.negativeMarkingEnabled,
          isActive: p.isActive,
        },
        create: {
          id: p.id,
          name: p.name,
          description: p.description,
          domainId: p.domainId,
          durationMinutes: p.durationMinutes,
          shuffleOptions: p.shuffleOptions,
          negativeMarkingEnabled: p.negativeMarkingEnabled,
          isActive: p.isActive,
          createdById: p.createdById,
          createdAt: new Date(p.createdAt),
          updatedAt: new Date(p.updatedAt),
        },
      });

      if (p.sections && p.sections.length > 0) {
        for (const sec of p.sections) {
          await prisma.paperSection.upsert({
            where: { id: sec.id },
            update: {
              title: sec.title,
              position: sec.position,
              questionCount: sec.questionCount,
              marksPerQuestion: sec.marksPerQuestion ? new Prisma.Decimal(sec.marksPerQuestion) : null,
              negativeMarksPerQuestion: sec.negativeMarksPerQuestion ? new Prisma.Decimal(sec.negativeMarksPerQuestion) : null,
            },
            create: {
              id: sec.id,
              paperId: p.id,
              key: sec.key,
              title: sec.title,
              position: sec.position,
              questionCount: sec.questionCount,
              marksPerQuestion: sec.marksPerQuestion ? new Prisma.Decimal(sec.marksPerQuestion) : null,
              negativeMarksPerQuestion: sec.negativeMarksPerQuestion ? new Prisma.Decimal(sec.negativeMarksPerQuestion) : null,
            },
          });
        }
      }
    }

    console.log('Restoring Students...');
    for (const st of data.students) {
      await prisma.student.upsert({
        where: { id: st.id },
        update: {
          fullName: st.fullName,
          collegeEmail: st.collegeEmail,
          personalEmail: st.personalEmail,
          collegeName: st.collegeName,
          location: st.location,
          department: st.department,
          yearOfPassing: st.yearOfPassing,
          domainLockedAt: st.domainLockedAt ? new Date(st.domainLockedAt) : null,
          deviceCheckCompletedAt: st.deviceCheckCompletedAt ? new Date(st.deviceCheckCompletedAt) : null,
          deviceCheckDetails: st.deviceCheckDetails,
          archivedAt: st.archivedAt ? new Date(st.archivedAt) : null,
        },
        create: {
          id: st.id,
          fullName: st.fullName,
          registrationNumber: st.registrationNumber,
          mobileNumber: st.mobileNumber,
          collegeEmail: st.collegeEmail,
          personalEmail: st.personalEmail,
          collegeName: st.collegeName,
          location: st.location,
          department: st.department,
          yearOfPassing: st.yearOfPassing,
          domainId: st.domainId,
          domainLockedAt: st.domainLockedAt ? new Date(st.domainLockedAt) : null,
          deviceCheckCompletedAt: st.deviceCheckCompletedAt ? new Date(st.deviceCheckCompletedAt) : null,
          deviceCheckDetails: st.deviceCheckDetails,
          archivedAt: st.archivedAt ? new Date(st.archivedAt) : null,
          createdAt: new Date(st.createdAt),
          updatedAt: new Date(st.updatedAt),
        },
      });

      if (st.education && st.education.length > 0) {
        for (const ed of st.education) {
          await prisma.educationRecord.upsert({
            where: { id: ed.id },
            update: { institutionName: ed.institutionName, yearOfCompletion: ed.yearOfCompletion, score: new Prisma.Decimal(ed.score) },
            create: {
              id: ed.id,
              studentId: st.id,
              level: ed.level,
              institutionName: ed.institutionName,
              yearOfCompletion: ed.yearOfCompletion,
              major: ed.major,
              gradeType: ed.gradeType,
              score: new Prisma.Decimal(ed.score),
              createdAt: new Date(ed.createdAt),
              updatedAt: new Date(ed.updatedAt),
            },
          });
        }
      }
    }

    console.log('\n=========================================');
    console.log('       RESTORE COMPLETED SUCCESSFULLY    ');
    console.log('=========================================');
    console.log(`Source file: ${backupFile}`);
    console.log('Database populated and ready!');
    console.log('=========================================\n');
  } catch (err) {
    console.error('Import failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
