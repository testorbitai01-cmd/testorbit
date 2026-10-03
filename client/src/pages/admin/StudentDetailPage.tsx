import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ImageOff, Printer } from 'lucide-react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { EDUCATION_LEVEL_LABELS, GRADE_TYPE_LABELS } from '@test-orbit/shared';
import { Badge, SessionStatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList, PageHeader } from '@/components/ui/Card';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { api } from '@/services/api';
import type { AdminUser, StudentDetail } from '@/types/api';
import { fmtDate, fmtDateTime } from '@/utils/format';
import { SessionDetailView } from './components/SessionDetailView';

export function StudentDetailPage() {
  const { studentId = '' } = useParams();
  const admin = useOutletContext<AdminUser>();
  const q = useQuery({ queryKey: ['admin', 'student', studentId], queryFn: () => api.get<StudentDetail>(`/admin/students/${studentId}`) });
  const [showPhoto, setShowPhoto] = useState(false);

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const { student, photo, sessions, auditHistory } = q.data!;

  return (
    <>
      <PageHeader
        back={
          <Link to="/admin/students" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink print:hidden">
            <ArrowLeft className="size-4" /> Students
          </Link>
        }
        title={student.fullName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {student.registrationNumber} · {student.domain.name} {sessions[0] ? <SessionStatusBadge status={sessions[0].status} /> : <SessionStatusBadge status="NOT_STARTED" />} {student.archivedAt && <Badge tone="warn">Archived (deleted by an admin; history kept)</Badge>}
          </span>
        }
        actions={
          <Button variant="secondary" icon={<Printer className="size-4" />} onClick={() => window.print()} className="print:hidden">
            Print report
          </Button>
        }
      />

      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
          <Card>
            <CardHeader title="Personal & contact details" />
            <CardBody>
              <DescriptionList
                columns={3}
                items={[
                  { label: 'Registration number', value: <span className="font-mono">{student.registrationNumber}</span> },
                  { label: 'Mobile', value: <span className="font-mono">{student.mobileNumber}</span> },
                  { label: 'College email', value: student.collegeEmail },
                  { label: 'Personal email', value: student.personalEmail },
                  { label: 'College', value: student.collegeName },
                  { label: 'Department', value: student.department },
                  { label: 'Location', value: student.location },
                  { label: 'Year of passing', value: student.yearOfPassing },
                  { label: 'Assessment domain', value: `${student.domain.name}${student.domainLockedAt ? ' (locked)' : ''}` },
                  { label: 'Registered', value: fmtDateTime(student.createdAt) },
                  { label: 'Device check', value: student.deviceCheckCompletedAt ? fmtDateTime(student.deviceCheckCompletedAt) : 'Not completed' },
                ]}
              />
            </CardBody>
          </Card>
          <Card className="print:hidden">
            <CardHeader title="Identity photo" />
            <CardBody>
              {photo.available ? (
                showPhoto ? (
                  <>
                    <img src={`/api/admin/students/${student.id}/photo`} alt={`Identity photo of ${student.fullName}`} className="aspect-[4/3] w-full rounded-lg bg-canvas object-cover" />
                    <p className="mt-2 text-xs text-ink-subtle">
                      Confirmed {fmtDateTime(photo.confirmedAt)} · deleted after {fmtDate(photo.retentionUntil)}
                    </p>
                  </>
                ) : (
                  <div className="space-y-3 text-sm text-ink-muted">
                    <p>Viewing the photo is recorded in the audit log.</p>
                    <Button variant="secondary" onClick={() => setShowPhoto(true)}>
                      Show photo
                    </Button>
                  </div>
                )
              ) : (
                <p className="flex items-center gap-2 text-sm text-ink-muted">
                  <ImageOff className="size-4" /> No photo on file
                </p>
              )}
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader title="Education history" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-canvas/70 text-xs uppercase tracking-wide text-ink-subtle">
                  <th className="px-5 py-2.5 font-semibold">Level</th>
                  <th className="px-5 py-2.5 font-semibold">Institution</th>
                  <th className="px-5 py-2.5 font-semibold">Stream / major</th>
                  <th className="px-5 py-2.5 font-semibold">Year</th>
                  <th className="px-5 py-2.5 font-semibold">Score</th>
                </tr>
              </thead>
              <tbody>
                {student.education.map((e) => (
                  <tr key={e.level} className="border-b border-line last:border-0">
                    <td className="px-5 py-3 font-medium">{e.level === 'HSC' ? '12th / Diploma' : EDUCATION_LEVEL_LABELS[e.level]}</td>
                    <td className="px-5 py-3">{e.institutionName}</td>
                    <td className="px-5 py-3">{e.major || '—'}</td>
                    <td className="px-5 py-3 tabular-nums">{e.yearOfCompletion}</td>
                    <td className="px-5 py-3 tabular-nums">
                      {e.score} <span className="text-xs text-ink-subtle">{GRADE_TYPE_LABELS[e.gradeType]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {sessions.length === 0 ? (
          <Card>
            <CardBody className="text-sm text-ink-muted">This student has not started an assessment.</CardBody>
          </Card>
        ) : (
          sessions.map((s) => <SessionDetailView key={s.id} session={s} admin={admin} onChanged={() => void q.refetch()} />)
        )}

        <Card>
          <CardHeader title="Admin actions & audit history" />
          <CardBody>
            {auditHistory.length === 0 ? (
              <p className="text-sm text-ink-muted">No admin actions recorded for this student.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {auditHistory.map((a) => (
                  <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2.5">
                    <span>
                      <span className="font-medium text-ink">{a.action.replaceAll('_', ' ').toLowerCase()}</span>{' '}
                      <span className="text-ink-muted">by {a.admin?.name ?? 'system'}</span>
                      {detailsSummary(a.details)}
                    </span>
                    <span className="text-xs text-ink-subtle">{fmtDateTime(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function detailsSummary(details: unknown) {
  if (!details || typeof details !== 'object') return null;
  const d = details as Record<string, unknown>;
  const parts: string[] = [];
  if ('oldValue' in d) parts.push(`${String(d.oldValue ?? '—')} → ${String(d.newValue)}`);
  if (typeof d.reason === 'string') parts.push(`“${d.reason}”`);
  if (typeof d.timeAdjustmentMinutes === 'number' && d.timeAdjustmentMinutes) parts.push(`${d.timeAdjustmentMinutes} min`);
  return parts.length ? <span className="text-ink-muted"> · {parts.join(' · ')}</span> : null;
}
