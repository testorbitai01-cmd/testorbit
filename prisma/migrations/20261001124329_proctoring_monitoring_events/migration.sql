-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProctoringEventType" ADD VALUE 'MULTIPLE_FACES_DETECTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'FACE_NOT_VISIBLE';
ALTER TYPE "ProctoringEventType" ADD VALUE 'SPEECH_DETECTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'CAMERA_MONITORING_UNAVAILABLE';
ALTER TYPE "ProctoringEventType" ADD VALUE 'MICROPHONE_MONITORING_UNAVAILABLE';

-- AlterTable
ALTER TABLE "ProctoringEvent" ADD COLUMN     "acknowledgedAt" TIMESTAMPTZ(3);
