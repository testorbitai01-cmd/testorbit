-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('ADMIN', 'REVIEWER');

-- CreateEnum
CREATE TYPE "SectionKey" AS ENUM ('A', 'B', 'C', 'D', 'E');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('MCQ', 'CODING');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "GradeType" AS ENUM ('PERCENTAGE', 'CGPA_10', 'CGPA_4', 'GPA_5');

-- CreateEnum
CREATE TYPE "EducationLevel" AS ENUM ('SSC', 'HSC', 'UG', 'PG');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('CREATED', 'IN_PROGRESS', 'INTERRUPTED', 'FLAGGED_FOR_REVIEW', 'SUBMITTED', 'EXPIRED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "ProctoringEventType" AS ENUM ('TAB_HIDDEN', 'WINDOW_BLUR', 'CAMERA_DISCONNECTED', 'MICROPHONE_DISCONNECTED', 'NETWORK_OFFLINE', 'NETWORK_RESTORED', 'PAGE_UNLOAD', 'SESSION_TERMINATED');

-- CreateEnum
CREATE TYPE "EventAction" AS ENUM ('LOGGED', 'WARNING', 'TERMINATED', 'IGNORED');

-- CreateEnum
CREATE TYPE "ReentryStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'USED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReentryTrigger" AS ENUM ('NETWORK_INTERRUPTION', 'POLICY_TERMINATION');

-- CreateEnum
CREATE TYPE "EvaluationStatus" AS ENUM ('NOT_EVALUATED', 'PENDING_MANUAL_REVIEW', 'COMPLETE');

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'ADMIN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "mobileNumber" TEXT NOT NULL,
    "collegeEmail" TEXT NOT NULL,
    "personalEmail" TEXT NOT NULL,
    "collegeName" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "yearOfPassing" INTEGER NOT NULL,
    "domainId" TEXT NOT NULL,
    "domainLockedAt" TIMESTAMP(3),
    "deviceCheckCompletedAt" TIMESTAMP(3),
    "deviceCheckDetails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAuthSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "StudentAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EducationRecord" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "level" "EducationLevel" NOT NULL,
    "institutionName" TEXT NOT NULL,
    "yearOfCompletion" INTEGER NOT NULL,
    "major" TEXT,
    "gradeType" "GradeType" NOT NULL,
    "score" DECIMAL(6,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EducationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityPhoto" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "storageDriver" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "retentionUntil" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "section" "SectionKey" NOT NULL,
    "type" "QuestionType" NOT NULL,
    "text" TEXT NOT NULL,
    "marks" DECIMAL(6,2) NOT NULL,
    "negativeMarks" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
    "explanation" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "externalRef" TEXT,
    "contentHash" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionOption" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionPaper" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "domainId" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 45,
    "shuffleOptions" BOOLEAN NOT NULL DEFAULT true,
    "negativeMarkingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionPaper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperSection" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "key" "SectionKey" NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "questionCount" INTEGER NOT NULL,
    "marksPerQuestion" DECIMAL(6,2),
    "negativeMarksPerQuestion" DECIMAL(6,2),

    CONSTRAINT "PaperSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentSession" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "SessionStatus" NOT NULL DEFAULT 'CREATED',
    "durationMinutes" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "frozenRemainingMs" INTEGER,
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastAnswerSavedAt" TIMESTAMP(3),
    "lastQuestionPosition" INTEGER,
    "interruptedAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "terminationReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submissionReason" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "timeAdjustmentMinutes" INTEGER NOT NULL DEFAULT 0,
    "resumeCount" INTEGER NOT NULL DEFAULT 0,
    "mcqScore" DECIMAL(8,2),
    "mcqMaxScore" DECIMAL(8,2),
    "codingScore" DECIMAL(8,2),
    "codingMaxScore" DECIMAL(8,2),
    "totalScore" DECIMAL(8,2),
    "maxScore" DECIMAL(8,2),
    "evaluationStatus" "EvaluationStatus" NOT NULL DEFAULT 'NOT_EVALUATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionQuestion" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "section" "SectionKey" NOT NULL,
    "sectionTitle" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "sectionPosition" INTEGER NOT NULL,
    "optionOrder" TEXT[],
    "marks" DECIMAL(6,2) NOT NULL,
    "negativeMarks" DECIMAL(6,2) NOT NULL,
    "isCorrect" BOOLEAN,
    "marksAwarded" DECIMAL(6,2),
    "evaluatedById" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "evaluatorComment" TEXT,

    CONSTRAINT "SessionQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAnswer" (
    "id" TEXT NOT NULL,
    "sessionQuestionId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "selectedOptionId" TEXT,
    "answerText" TEXT,
    "clientSeq" BIGINT NOT NULL,
    "firstSavedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProctoringEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "type" "ProctoringEventType" NOT NULL,
    "clientEventId" TEXT,
    "clientTime" TIMESTAMP(3),
    "ruleGroup" TEXT NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "action" "EventAction" NOT NULL,
    "warningNumber" INTEGER,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProctoringEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReentryRequest" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "trigger" "ReentryTrigger" NOT NULL,
    "status" "ReentryStatus" NOT NULL DEFAULT 'PENDING',
    "remainingMsAtRequest" INTEGER NOT NULL,
    "studentNote" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "timeAdjustmentMinutes" INTEGER NOT NULL DEFAULT 0,
    "resumeCodeHash" TEXT,
    "resumeCodeExpiresAt" TIMESTAMP(3),
    "resumeFailedAttempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReentryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_adminId_idx" ON "AdminSession"("adminId");

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_entityType_entityId_idx" ON "AdminAuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminId_idx" ON "AdminAuditLog"("adminId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_idx" ON "AdminAuditLog"("action");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_slug_key" ON "Domain"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_name_key" ON "Domain"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Student_registrationNumber_key" ON "Student"("registrationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Student_mobileNumber_key" ON "Student"("mobileNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Student_collegeEmail_key" ON "Student"("collegeEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Student_personalEmail_key" ON "Student"("personalEmail");

-- CreateIndex
CREATE INDEX "Student_fullName_idx" ON "Student"("fullName");

-- CreateIndex
CREATE INDEX "Student_collegeName_idx" ON "Student"("collegeName");

-- CreateIndex
CREATE INDEX "Student_department_idx" ON "Student"("department");

-- CreateIndex
CREATE INDEX "Student_yearOfPassing_idx" ON "Student"("yearOfPassing");

-- CreateIndex
CREATE INDEX "Student_domainId_idx" ON "Student"("domainId");

-- CreateIndex
CREATE INDEX "Student_createdAt_idx" ON "Student"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAuthSession_tokenHash_key" ON "StudentAuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "StudentAuthSession_studentId_idx" ON "StudentAuthSession"("studentId");

-- CreateIndex
CREATE INDEX "StudentAuthSession_expiresAt_idx" ON "StudentAuthSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EducationRecord_studentId_level_key" ON "EducationRecord"("studentId", "level");

-- CreateIndex
CREATE INDEX "IdentityPhoto_studentId_idx" ON "IdentityPhoto"("studentId");

-- CreateIndex
CREATE INDEX "IdentityPhoto_retentionUntil_idx" ON "IdentityPhoto"("retentionUntil");

-- CreateIndex
CREATE INDEX "Question_domainId_section_type_isActive_idx" ON "Question"("domainId", "section", "type", "isActive");

-- CreateIndex
CREATE INDEX "Question_contentHash_idx" ON "Question"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "Question_domainId_externalRef_key" ON "Question"("domainId", "externalRef");

-- CreateIndex
CREATE INDEX "QuestionOption_questionId_idx" ON "QuestionOption"("questionId");

-- CreateIndex
CREATE INDEX "QuestionPaper_domainId_isActive_idx" ON "QuestionPaper"("domainId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PaperSection_paperId_key_key" ON "PaperSection"("paperId", "key");

-- CreateIndex
CREATE INDEX "AssessmentSession_status_idx" ON "AssessmentSession"("status");

-- CreateIndex
CREATE INDEX "AssessmentSession_paperId_idx" ON "AssessmentSession"("paperId");

-- CreateIndex
CREATE INDEX "AssessmentSession_startedAt_idx" ON "AssessmentSession"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentSession_studentId_attemptNumber_key" ON "AssessmentSession"("studentId", "attemptNumber");

-- CreateIndex
CREATE INDEX "SessionQuestion_questionId_idx" ON "SessionQuestion"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionQuestion_sessionId_position_key" ON "SessionQuestion"("sessionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SessionQuestion_sessionId_questionId_key" ON "SessionQuestion"("sessionId", "questionId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAnswer_sessionQuestionId_key" ON "StudentAnswer"("sessionQuestionId");

-- CreateIndex
CREATE INDEX "StudentAnswer_sessionId_idx" ON "StudentAnswer"("sessionId");

-- CreateIndex
CREATE INDEX "ProctoringEvent_sessionId_type_idx" ON "ProctoringEvent"("sessionId", "type");

-- CreateIndex
CREATE INDEX "ProctoringEvent_studentId_idx" ON "ProctoringEvent"("studentId");

-- CreateIndex
CREATE INDEX "ProctoringEvent_createdAt_idx" ON "ProctoringEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProctoringEvent_sessionId_clientEventId_key" ON "ProctoringEvent"("sessionId", "clientEventId");

-- CreateIndex
CREATE INDEX "ReentryRequest_status_idx" ON "ReentryRequest"("status");

-- CreateIndex
CREATE INDEX "ReentryRequest_sessionId_idx" ON "ReentryRequest"("sessionId");

-- CreateIndex
CREATE INDEX "ReentryRequest_studentId_idx" ON "ReentryRequest"("studentId");

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAuthSession" ADD CONSTRAINT "StudentAuthSession_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EducationRecord" ADD CONSTRAINT "EducationRecord_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityPhoto" ADD CONSTRAINT "IdentityPhoto_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionOption" ADD CONSTRAINT "QuestionOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionPaper" ADD CONSTRAINT "QuestionPaper_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionPaper" ADD CONSTRAINT "QuestionPaper_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSection" ADD CONSTRAINT "PaperSection_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "QuestionPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentSession" ADD CONSTRAINT "AssessmentSession_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentSession" ADD CONSTRAINT "AssessmentSession_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "QuestionPaper"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionQuestion" ADD CONSTRAINT "SessionQuestion_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AssessmentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionQuestion" ADD CONSTRAINT "SessionQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionQuestion" ADD CONSTRAINT "SessionQuestion_evaluatedById_fkey" FOREIGN KEY ("evaluatedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAnswer" ADD CONSTRAINT "StudentAnswer_sessionQuestionId_fkey" FOREIGN KEY ("sessionQuestionId") REFERENCES "SessionQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAnswer" ADD CONSTRAINT "StudentAnswer_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AssessmentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAnswer" ADD CONSTRAINT "StudentAnswer_selectedOptionId_fkey" FOREIGN KEY ("selectedOptionId") REFERENCES "QuestionOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProctoringEvent" ADD CONSTRAINT "ProctoringEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AssessmentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProctoringEvent" ADD CONSTRAINT "ProctoringEvent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReentryRequest" ADD CONSTRAINT "ReentryRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AssessmentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReentryRequest" ADD CONSTRAINT "ReentryRequest_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReentryRequest" ADD CONSTRAINT "ReentryRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
