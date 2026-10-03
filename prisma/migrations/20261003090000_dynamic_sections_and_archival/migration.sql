-- Dynamic paper sections + safe archival of students and questions.
-- Non-destructive: the section enum columns are converted in place to TEXT
-- (existing 'A'..'E' values are preserved), and the new columns are nullable.

-- Section keys: enum -> text (any number of sections per paper)
ALTER TABLE "Question" ALTER COLUMN "section" TYPE TEXT USING "section"::text;
ALTER TABLE "PaperSection" ALTER COLUMN "key" TYPE TEXT USING "key"::text;
ALTER TABLE "SessionQuestion" ALTER COLUMN "section" TYPE TEXT USING "section"::text;
DROP TYPE "SectionKey";

-- Archival (soft delete) for records referenced by assessment history
ALTER TABLE "Question" ADD COLUMN "archivedAt" TIMESTAMPTZ(3);
ALTER TABLE "Student" ADD COLUMN "archivedAt" TIMESTAMPTZ(3);
CREATE INDEX "Student_archivedAt_idx" ON "Student"("archivedAt");
