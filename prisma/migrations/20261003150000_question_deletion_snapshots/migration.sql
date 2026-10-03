-- Allow questions used in assessments to be deleted from the bank without touching history.
-- Non-destructive: no rows are changed; only constraints are relaxed and a nullable column added.

-- SessionQuestion keeps its row when the question is deleted (questionId -> NULL) and stores a snapshot.
ALTER TABLE "SessionQuestion" DROP CONSTRAINT "SessionQuestion_questionId_fkey";
ALTER TABLE "SessionQuestion" ALTER COLUMN "questionId" DROP NOT NULL;
ALTER TABLE "SessionQuestion" ADD COLUMN "questionSnapshot" JSONB;
ALTER TABLE "SessionQuestion" ADD CONSTRAINT "SessionQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A student's recorded answer keeps the chosen option id even after the option is deleted.
ALTER TABLE "StudentAnswer" DROP CONSTRAINT "StudentAnswer_selectedOptionId_fkey";
