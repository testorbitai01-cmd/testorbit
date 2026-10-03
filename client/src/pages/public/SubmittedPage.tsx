import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock } from 'lucide-react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, DescriptionList } from '@/components/ui/Card';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { studentKeys } from '@/hooks/useStudent';
import { ApiError, api } from '@/services/api';
import { releaseMedia } from '@/services/media';
import type { AssessmentView } from '@/types/api';
import { fmtDateTime, fmtMarks } from '@/utils/format';

export function SubmittedPage() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ['assessment-final', sessionId], queryFn: () => api.get<AssessmentView>(`/assessment/${sessionId}`) });

  // The assessment is over: turn the camera and microphone off.
  useEffect(() => releaseMedia(), []);

  if (view.isLoading) return <LoadingState />;
  if (view.error) {
    if (view.error instanceof ApiError && view.error.status === 401) return <Navigate to="/" replace />;
    return <ErrorState error={view.error} onRetry={() => void view.refetch()} />;
  }
  const v = view.data!;
  if (v.session.status === 'IN_PROGRESS') return <Navigate to={`/assessment/${sessionId}`} replace />;
  if (v.session.status !== 'SUBMITTED' && v.session.status !== 'EXPIRED') return <Navigate to="/session-status" replace />;
  const expired = v.session.status === 'EXPIRED';
  const s = v.summary;

  const signOut = async () => {
    await api.post('/students/sign-out').catch(() => undefined);
    qc.setQueryData(studentKeys.me, null);
    navigate('/', { replace: true });
  };

  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <CardBody className="p-8 text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            {expired ? <Clock className="size-7" /> : <CheckCircle2 className="size-7" />}
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">{expired ? 'Time is up — your assessment was submitted' : 'Assessment submitted'}</h1>
          <p className="mt-2 text-sm text-ink-muted">
            Thank you, {v.student.fullName}. Your answers have been recorded. MCQs are scored automatically; coding answers are reviewed by technical staff. The placement team will
            share results.
          </p>
        </CardBody>
        {s && (
          <CardBody className="border-t border-line">
            <DescriptionList
              items={[
                { label: 'Registration number', value: v.student.registrationNumber },
                { label: 'Domain', value: v.student.domainName },
                { label: 'Submitted at', value: fmtDateTime(s.submittedAt) },
                { label: 'Questions answered', value: `${s.answeredCount} of ${s.totalQuestions}` },
                ...(s.score ? [{ label: 'MCQ score', value: `${fmtMarks(s.score.mcqScore)} / ${fmtMarks(s.score.mcqMaxScore)}` }] : []),
              ]}
            />
          </CardBody>
        )}
        <CardBody className="flex justify-center border-t border-line">
          <Button variant="secondary" onClick={signOut}>
            Sign out
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
