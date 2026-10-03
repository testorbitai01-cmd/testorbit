import { Router } from 'express';
import { requireAdmin, requireRole } from './middleware/auth.js';
import { adminAssessmentsRouter } from './modules/admin/assessments.routes.js';
import { auditRouter } from './modules/admin/audit.routes.js';
import { dashboardRouter } from './modules/admin/dashboard.routes.js';
import { domainsRouter } from './modules/admin/domains.routes.js';
import { papersRouter } from './modules/admin/papers.routes.js';
import { questionsRouter } from './modules/admin/questions.routes.js';
import { reentryRouter } from './modules/admin/reentry.routes.js';
import { reportsRouter } from './modules/admin/reports.routes.js';
import { settingsRouter } from './modules/admin/settings.routes.js';
import { adminStudentsRouter } from './modules/admin/students.routes.js';
import { assessmentRouter } from './modules/assessment/assessment.routes.js';
import { adminAuthRouter } from './modules/auth/adminAuth.routes.js';
import { deviceCheckRouter } from './modules/deviceCheck/deviceCheck.routes.js';
import { studentRouter } from './modules/students/student.routes.js';

export const apiRouter = Router();

// Public + student
apiRouter.use('/auth/admin', adminAuthRouter);
apiRouter.use('/students', studentRouter);
apiRouter.use('/', deviceCheckRouter);
apiRouter.use('/assessment', assessmentRouter);

// Admin — every route below requires an authenticated admin session (server-side check).
const admin = Router();
admin.use(requireAdmin());
admin.use('/dashboard', dashboardRouter);
admin.use('/domains', domainsRouter);
admin.use('/students', adminStudentsRouter);
admin.use('/assessments', adminAssessmentsRouter);
admin.use('/reports', reportsRouter);
// Answer keys, papers, re-entry decisions, audit logs and settings: ADMIN role only.
admin.use('/questions', requireRole('ADMIN'), questionsRouter);
admin.use('/papers', requireRole('ADMIN'), papersRouter);
admin.use('/reentry', requireRole('ADMIN'), reentryRouter);
admin.use('/audit-logs', requireRole('ADMIN'), auditRouter);
admin.use('/settings', requireRole('ADMIN'), settingsRouter);
apiRouter.use('/admin', admin);
