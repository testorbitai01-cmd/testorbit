import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DomainsPage } from '@/pages/admin/DomainsPage';
import { PaperDetailPage } from '@/pages/admin/PaperDetailPage';
import { PapersPage } from '@/pages/admin/PapersPage';
import { QuestionBankPage } from '@/pages/admin/QuestionBankPage';
import { ReentryPage } from '@/pages/admin/ReentryPage';
import { StudentsPage } from '@/pages/admin/StudentsPage';
import { jsonResponse, mockFetch, renderWithProviders } from '@/test/utils';

afterEach(() => vi.unstubAllGlobals());

// jsdom has no modal <dialog> support; the app's Dialog component only needs these two methods.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const ADMIN = { id: 'a1', email: 'admin@gradtwin.com', name: 'Admin', role: 'ADMIN', mustChangePassword: false };
const REVIEWER = { ...ADMIN, id: 'r1', role: 'REVIEWER' };

/** Admin pages read the signed-in admin from the layout's outlet context. */
function renderAdmin(path: string, pattern: string, element: React.ReactNode, admin: object = ADMIN) {
  return renderWithProviders(
    <Routes>
      <Route element={<Outlet context={admin} />}>
        <Route path={pattern} element={element} />
      </Route>
    </Routes>,
    { route: path },
  );
}

const domainRow = (slug: string, name: string, extra: object = {}) => ({
  slug,
  name,
  isActive: true,
  students: 0,
  activePaper: null,
  mcqQuestions: 0,
  codingQuestions: 0,
  paperCount: 0,
  questionCount: 0,
  ...extra,
});

const DOMAINS = {
  items: [domainRow('ai-ml', 'AI/ML', { students: 3, questionCount: 40 }), domainRow('cloud-devops', 'Cloud & DevOps'), domainRow('legacy', 'Legacy Track', { isActive: false })],
};

const body = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? '{}'));

// ───────────────────────────── Question paper editor ─────────────────────────────

describe('PaperDetailPage', () => {
  const pools = {
    pools: [
      ...['A', 'B', 'C'].map((section) => ({ domain: 'cloud-devops', section, type: 'MCQ', count: 12 })),
      { domain: 'cloud-devops', section: 'D', type: 'MCQ', count: 6 },
      { domain: 'cloud-devops', section: 'E', type: 'CODING', count: 6 },
      { domain: 'cloud-devops', section: 'F', type: 'MCQ', count: 3 },
      { domain: 'ai-ml', section: 'A', type: 'MCQ', count: 30 },
    ],
    sections: ['A', 'B', 'C', 'D', 'E', 'F'],
  };

  it('lists database domains, adds and removes sections, validates pool counts and saves a 6-section paper', async () => {
    const saved: unknown[] = [];
    mockFetch({
      'GET /api/admin/domains': () => jsonResponse(DOMAINS),
      'GET /api/admin/questions/pool-summary': () => jsonResponse(pools),
      'GET /api/admin/papers': () => jsonResponse({ items: [] }),
      'GET /api/admin/settings/paper-defaults': () => jsonResponse({ paperDefaults: { durationMinutes: 45, sectionCounts: { A: 10, B: 10, C: 10, D: 5, E: 5 } } }),
      'POST /api/admin/papers': (init) => {
        saved.push(body(init));
        return jsonResponse({ error: { code: 'X', message: 'stop here' } }, 409);
      },
    });
    renderAdmin('/admin/question-papers/new', '/admin/question-papers/:paperId', <PaperDetailPage />);

    // Domain selector is built from the database: open domains only (closed "Legacy Track" hidden).
    const domain = await screen.findByLabelText(/^Domain/);
    await waitFor(() => expect(within(domain).getByRole('option', { name: 'Cloud & DevOps' })).toBeInTheDocument());
    expect(within(domain).queryByRole('option', { name: /Legacy/ })).toBeNull();
    await userEvent.selectOptions(domain, 'cloud-devops');
    await userEvent.type(screen.getByLabelText(/^Paper name/), 'DevOps Screening — Round 1');

    // Pool counts are the live MCQ / coding numbers for the selected domain.
    expect(screen.getAllByText('12 available (12 / 0)')).toHaveLength(3);
    expect(screen.getByText('6 available (0 / 6)')).toBeInTheDocument();

    // Add section → next free identifier F with its own pool.
    await userEvent.click(screen.getByRole('button', { name: 'Add section' }));
    expect(screen.getByLabelText('Section 6 identifier')).toHaveValue('F');
    expect(screen.getByText('3 available (3 / 0)')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Section F question count'));
    await userEvent.type(screen.getByLabelText('Section F question count'), '2');
    await userEvent.clear(screen.getByLabelText('Section F title'));
    await userEvent.type(screen.getByLabelText('Section F title'), 'Linux basics');

    // A section with an empty pool is removed directly; one with questions asks first.
    await userEvent.click(screen.getByRole('button', { name: 'Add section' }));
    expect(screen.getByLabelText('Section 7 identifier')).toHaveValue('G');
    await userEvent.click(screen.getByRole('button', { name: 'Remove section G' }));
    expect(screen.queryByLabelText('Section 7 identifier')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove section E' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove section E?' });
    expect(within(confirm).getByText(/6 active question\(s\) are tagged with section E/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Section E title')).toBeInTheDocument();

    // Requesting more than the pool is flagged per row and blocks saving.
    await userEvent.clear(screen.getByLabelText('Section A question count'));
    await userEvent.type(screen.getByLabelText('Section A question count'), '20');
    expect(screen.getByText('Requested 20: exceeds the pool')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create paper' }));
    expect(saved).toHaveLength(0);
    expect(screen.getByText(/asks for more questions than the active Cloud & DevOps pool/)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Section A question count'));
    await userEvent.type(screen.getByLabelText('Section A question count'), '12');
    await userEvent.click(screen.getByRole('button', { name: 'Create paper' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const sent = saved[0] as { name: string; domainSlug: string; sections: { key: string; title: string; questionCount: string | number }[] };
    expect(sent.name).toBe('DevOps Screening — Round 1');
    expect(sent.domainSlug).toBe('cloud-devops');
    expect(sent.sections.map((s) => [s.key, s.title, Number(s.questionCount)])).toEqual([
      ['A', 'Section A', 12],
      ['B', 'Section B', 10],
      ['C', 'Section C', 10],
      ['D', 'Section D', 5],
      ['E', 'Section E', 5],
      ['F', 'Linux basics', 2],
    ]);
    expect(sent.sections[0]).not.toHaveProperty('uid'); // client-only row id is never sent
  }, 20_000); // types a lot of input; allow for a loaded CI machine
});

describe('PaperDetailPage total', () => {
  it('derives the total from the section counts and updates it as they change', async () => {
    mockFetch({
      'GET /api/admin/domains': () => jsonResponse(DOMAINS),
      'GET /api/admin/questions/pool-summary': () => jsonResponse({ pools: ['A', 'B', 'C', 'D', 'E'].map((section) => ({ domain: 'ai-ml', section, type: 'MCQ', count: 30 })), sections: ['A', 'B', 'C', 'D', 'E'] }),
      'GET /api/admin/papers': () => jsonResponse({ items: [] }),
      'GET /api/admin/settings/paper-defaults': () => jsonResponse({ paperDefaults: { durationMinutes: 45, sectionCounts: { A: 10, B: 10, C: 10, D: 5, E: 5 } } }),
    });
    renderAdmin('/admin/question-papers/new', '/admin/question-papers/:paperId', <PaperDetailPage />);
    await screen.findByLabelText('Section A question count');
    for (const [key, n] of Object.entries({ A: 2, B: 1, C: 2, D: 1, E: 2 })) {
      const input = screen.getByLabelText(`Section ${key} question count`);
      await userEvent.clear(input);
      await userEvent.type(input, String(n));
    }
    expect(screen.getByText('8 questions in total')).toBeInTheDocument();
    const a = screen.getByLabelText('Section A question count');
    await userEvent.clear(a);
    await userEvent.type(a, '10');
    expect(screen.getByText('16 questions in total')).toBeInTheDocument();
    // A section's own pool (30) is larger than what the admin asks for; that is valid.
    expect(screen.queryByText(/exceeds the pool/)).toBeNull();
  });
});

// ───────────────────────────── Students ─────────────────────────────

describe('ReentryPage bulk approval', () => {
  const row = (id: string, fullName: string, extra: object = {}) => ({
    id,
    status: 'PENDING',
    trigger: 'NETWORK_INTERRUPTION',
    createdAt: '2026-10-04T10:00:00.000Z',
    decidedBy: null,
    student: { id: `st-${id}`, fullName, mobileNumber: '9876543210', collegeName: 'Orbit Institute' },
    domainName: 'AI/ML',
    session: { id: `se-${id}`, status: 'INTERRUPTED', lastAnswerSavedAt: null, remainingMs: 600_000, eventCount: 1 },
    ...extra,
  });
  const list = {
    items: [row('r1', 'Asha Kumar'), row('r2', 'Ravi Shah'), row('r3', 'Done Already', { status: 'USED', session: { id: 'se-r3', status: 'IN_PROGRESS', lastAnswerSavedAt: null, remainingMs: 0, eventCount: 0 } })],
    total: 3,
    page: 1,
    pageSize: 20,
  };
  const base = {
    'GET /api/admin/reentry': () => jsonResponse(list),
    'GET /api/admin/students/filters': () => jsonResponse({ colleges: [], departments: [], years: [] }),
    'GET /api/admin/domains': () => jsonResponse(DOMAINS),
  };

  it('approves the selected pending requests and lists every one-time code', async () => {
    const posts: unknown[] = [];
    mockFetch({
      ...base,
      'POST /api/admin/reentry/bulk-approve': (init) => {
        posts.push(body(init));
        return jsonResponse({
          approved: 1,
          failed: 1,
          results: [
            { requestId: 'r1', ok: true, student: { fullName: 'Asha Kumar', registrationNumber: 'REG001' }, resumeCode: 'K7Q2M9XA', resumeCodeExpiresAt: '2026-10-04T11:00:00.000Z' },
            { requestId: 'r2', ok: false, error: 'This request has already been approved' },
          ],
        });
      },
    });
    renderAdmin('/admin/reentry', '/admin/reentry', <ReentryPage />);

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select all pending requests on this page' }));
    // Only decidable rows are selectable: the used request has no checkbox.
    expect(screen.queryByRole('checkbox', { name: 'Select Done Already' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toHaveTextContent('2 pending requests selected');

    await userEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve 2 re-entry requests' });
    const confirm = within(dialog).getByRole('button', { name: 'Approve 2' });
    expect(confirm).toBeDisabled(); // a reason is required
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Lab 3 Wi-Fi outage');
    await userEvent.click(confirm);

    await waitFor(() => expect(posts).toEqual([{ requestIds: ['r1', 'r2'], reason: 'Lab 3 Wi-Fi outage', timeAdjustmentMinutes: 0 }]));
    const codes = await screen.findByRole('dialog', { name: 'Resume codes' });
    expect(within(codes).getByText('K7Q2M9XA')).toBeInTheDocument();
    expect(within(codes).getByText('REG001')).toBeInTheDocument();
    expect(within(codes).getByText(/Ravi Shah: This request has already been approved/)).toBeInTheDocument();
  });

  it('reviewers see no selection or bulk approval', async () => {
    mockFetch(base);
    renderAdmin('/admin/reentry', '/admin/reentry', <ReentryPage />, REVIEWER);
    expect(await screen.findByText('Asha Kumar')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('StudentsPage', () => {
  const rows = { items: [{ id: 's1', fullName: 'Asha Kumar', mobileNumber: '9876543210', collegeName: 'Orbit Institute' }, { id: 's2', fullName: 'Ravi Shah', mobileNumber: '9876543211', collegeName: 'City College' }], total: 2, page: 1, pageSize: 20 };
  const base = {
    'GET /api/admin/students': () => jsonResponse(rows),
    'GET /api/admin/students/filters': () => jsonResponse({ colleges: [], departments: [], years: [] }),
    'GET /api/admin/domains': () => jsonResponse(DOMAINS),
  };

  it('deletes one student after a confirmation that names them', async () => {
    const deleted: string[] = [];
    mockFetch({
      ...base,
      'DELETE /api/admin/students/s1': (_i, url) => {
        deleted.push(url);
        return jsonResponse({ outcome: 'archived' });
      },
    });
    renderAdmin('/admin/students', '/admin/students', <StudentsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Asha Kumar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this student?' });
    expect(within(dialog).getByText('Asha Kumar')).toBeInTheDocument();
    expect(within(dialog).getByText(/9876543210 · Orbit Institute/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete student' }));
    await waitFor(() => expect(deleted).toHaveLength(1));
    expect(await screen.findByText('Asha Kumar archived')).toBeInTheDocument();
  });

  it('delete all shows the affected count and needs the typed confirmation', async () => {
    const posts: unknown[] = [];
    mockFetch({
      ...base,
      'GET /api/admin/students/delete-all/preview': () => jsonResponse({ total: 5, toDelete: 3, toArchive: 1, skipped: 1 }),
      'POST /api/admin/students/delete-all': (init) => {
        posts.push(body(init));
        return jsonResponse({ deleted: 3, archived: 1, skipped: 1 });
      },
    });
    renderAdmin('/admin/students', '/admin/students', <StudentsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete all students' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete all students' });
    expect(await within(dialog).findByText('4 of 5 students will be removed')).toBeInTheDocument();
    expect(within(dialog).getByText(/1 with an assessment in progress or under review: skipped/)).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Delete 4 students' });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Type DELETE to confirm/), 'delete');
    expect(go).toBeDisabled(); // exact, case-sensitive word
    await userEvent.clear(within(dialog).getByLabelText(/Type DELETE to confirm/));
    await userEvent.type(within(dialog).getByLabelText(/Type DELETE to confirm/), 'DELETE');
    await userEvent.click(go);
    await waitFor(() => expect(posts).toEqual([{ confirm: 'DELETE' }]));
  });

  it('edits a student with registration validation and saves through the API', async () => {
    const puts: unknown[] = [];
    const detail = {
      student: {
        id: 's1',
        fullName: 'Asha Kumar',
        registrationNumber: 'REG1',
        mobileNumber: '9876543210',
        collegeEmail: 'asha@college.edu',
        personalEmail: 'asha@gmail.com',
        collegeName: 'Orbit Institute',
        location: 'Pune',
        department: 'CSE',
        yearOfPassing: 2026,
        domain: { slug: 'ai-ml', name: 'AI/ML' },
        domainLockedAt: null,
        archivedAt: null,
        education: [
          { level: 'SSC', institutionName: 'City School', yearOfCompletion: 2020, major: null, gradeType: 'PERCENTAGE', score: 90 },
          { level: 'HSC', institutionName: 'City HSS', yearOfCompletion: 2022, major: 'Science', gradeType: 'PERCENTAGE', score: 85 },
          { level: 'UG', institutionName: 'Orbit Institute', yearOfCompletion: 2026, major: 'B.E. CSE', gradeType: 'CGPA_10', score: 8.1 },
        ],
      },
      photo: { available: false },
      sessions: [],
      auditHistory: [],
    };
    mockFetch({
      ...base,
      'GET /api/admin/students/s1': () => jsonResponse(detail),
      'PUT /api/admin/students/s1': (init) => {
        puts.push(body(init));
        return jsonResponse({ id: 's1', changedFields: ['mobileNumber'] });
      },
    });
    renderAdmin('/admin/students', '/admin/students', <StudentsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Asha Kumar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit student' });
    const mobile = await within(dialog).findByLabelText(/^Mobile number/);
    expect(mobile).toHaveValue('9876543210');

    await userEvent.clear(mobile);
    await userEvent.type(mobile, '12345');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText(/Enter a valid 10-digit mobile number/)).toBeInTheDocument();
    expect(puts).toHaveLength(0);

    await userEvent.clear(mobile);
    await userEvent.type(mobile, '9123456789');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ mobileNumber: '9123456789', domainSlug: 'ai-ml', education: { PG: null, UG: { major: 'B.E. CSE' } } });
  });

  it('permanently deletes a test student with history only after the explicit option and typed DELETE', async () => {
    const calls: unknown[] = [];
    mockFetch({
      ...base,
      'DELETE /api/admin/students/s2': (init) => {
        calls.push(init?.body ? body(init) : null);
        return jsonResponse({ outcome: 'purged', removed: { sessions: 1, answers: 4, events: 2, reentryRequests: 1 } });
      },
    });
    renderAdmin('/admin/students', '/admin/students', <StudentsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Ravi Shah' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this student?' });
    expect(within(dialog).getByRole('button', { name: 'Delete student' })).toBeEnabled();
    await userEvent.click(within(dialog).getByLabelText(/Also permanently delete this student’s assessment history/));
    expect(within(dialog).getByText(/sessions, answers, marks, proctoring events and re-entry requests are permanently deleted/)).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Delete student and history' });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Type DELETE to confirm/), 'DELETE');
    await userEvent.click(go);
    await waitFor(() => expect(calls).toEqual([{ includeHistory: true, confirm: 'DELETE' }]));
    expect(await screen.findByText('Ravi Shah and their assessment history deleted')).toBeInTheDocument();
  });

  it('a plain delete sends no history option', async () => {
    const calls: unknown[] = [];
    mockFetch({
      ...base,
      'DELETE /api/admin/students/s1': (init) => {
        calls.push(init?.body ?? null);
        return jsonResponse({ outcome: 'deleted' });
      },
    });
    renderAdmin('/admin/students', '/admin/students', <StudentsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Asha Kumar' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this student?' })).getByRole('button', { name: 'Delete student' }));
    await waitFor(() => expect(calls).toEqual([null]));
  });

  it('hides edit and delete actions from reviewers', async () => {
    mockFetch(base);
    renderAdmin('/admin/students', '/admin/students', <StudentsPage />, REVIEWER);
    expect(await screen.findByText('Asha Kumar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit Asha/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete all students' })).toBeNull();
  });
});

// ───────────────────────────── Domains ─────────────────────────────

describe('DomainsPage', () => {
  it('adds a domain with an auto-generated identifier; every domain can be deleted by an admin', async () => {
    const posts: unknown[] = [];
    mockFetch({
      'GET /api/admin/domains': () => jsonResponse(DOMAINS),
      'POST /api/admin/domains': (init) => {
        posts.push(body(init));
        return jsonResponse({ slug: 'data-engineering', name: 'Data Engineering', isActive: true }, 201);
      },
    });
    renderAdmin('/admin/domains', '/admin/domains', <DomainsPage />);
    expect(await screen.findByRole('button', { name: 'Delete AI/ML' })).toBeEnabled(); // even with students
    expect(screen.getByRole('button', { name: 'Delete Cloud & DevOps' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add domain' });
    await userEvent.type(within(dialog).getByLabelText(/^Domain name/), 'Data Engineering');
    expect(within(dialog).getByLabelText(/^Identifier/)).toHaveValue('data-engineering');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add domain' }));
    await waitFor(() => expect(posts).toEqual([{ name: 'Data Engineering', slug: 'data-engineering', isActive: true }]));
  });
});

describe('DomainsPage delete', () => {
  it('shows what will be removed (students, assessments, papers, questions) and deletes only after typing DELETE', async () => {
    const calls: unknown[] = [];
    mockFetch({
      'GET /api/admin/domains': () => jsonResponse({ items: [domainRow('ai-ml', 'AI/ML', { students: 1, assessmentCount: 5, paperCount: 2, questionCount: 7 })] }),
      'GET /api/admin/domains/ai-ml/delete-preview': () =>
        jsonResponse({ slug: 'ai-ml', name: 'AI/ML', students: 1, archivedStudents: 5, assessments: 5, runningAssessments: [], papers: 2, activePapers: ['AI/ML — Sample Campus Drive'], questions: 0 }),
      'DELETE /api/admin/domains/ai-ml': (init) => {
        calls.push(body(init));
        return jsonResponse({ deleted: { students: 6, assessments: 5, papers: 2, questions: 0 } });
      },
    });
    renderAdmin('/admin/domains', '/admin/domains', <DomainsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete AI/ML' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete AI/ML?' });
    expect(await within(dialog).findByText(/6 student\(s\) \(including 5 previously deleted\/archived\), with their 5 assessment\(s\), answers,\s+marks and proctoring events/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 question paper\(s\), including the active paper “AI\/ML — Sample Campus Drive”/)).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Delete domain' });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Type DELETE to confirm/), 'DELETE');
    await userEvent.click(go);
    await waitFor(() => expect(calls).toEqual([{ confirm: 'DELETE' }]));
    expect(await screen.findByText('AI/ML deleted')).toBeInTheDocument();
  });

  it('cannot be confirmed while a student of the domain is taking an assessment', async () => {
    mockFetch({
      'GET /api/admin/domains': () => jsonResponse({ items: [domainRow('ai-ml', 'AI/ML', { students: 1 })] }),
      'GET /api/admin/domains/ai-ml/delete-preview': () =>
        jsonResponse({ slug: 'ai-ml', name: 'AI/ML', students: 1, archivedStudents: 0, assessments: 1, runningAssessments: [{ fullName: 'Nithesh', registrationNumber: 'E0121007' }], papers: 1, activePapers: [], questions: 3 }),
    });
    renderAdmin('/admin/domains', '/admin/domains', <DomainsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete AI/ML' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete AI/ML?' });
    expect(await within(dialog).findByText(/Nithesh \(E0121007\) is taking an assessment right now/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Type DELETE/)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Delete domain' })).toBeDisabled();
  });

  it('links “No Active Paper” to the question papers list', async () => {
    mockFetch({ 'GET /api/admin/domains': () => jsonResponse({ items: [domainRow('ai-ml-ds', 'AI/ML/DS')] }) });
    renderAdmin('/admin/domains', '/admin/domains', <DomainsPage />);
    expect(await screen.findByText('No Active Paper')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Activate a paper' })).toHaveAttribute('href', '/admin/question-papers');
  });
});

// ───────────────────────────── Question bank ─────────────────────────────

describe('QuestionBankPage', () => {
  const question = (id: string, usageCount: number) => ({
    id,
    domain: { slug: 'ai-ml', name: 'AI/ML' },
    section: 'F',
    type: 'MCQ',
    text: `Question ${id}?`,
    marks: 1,
    negativeMarks: 0,
    difficulty: 'EASY',
    explanation: null,
    isActive: true,
    externalRef: null,
    usageCount,
    createdAt: '',
    updatedAt: '',
    options: [
      { id: 'o1', text: 'Yes', isCorrect: true, position: 1 },
      { id: 'o2', text: 'No', isCorrect: false, position: 2 },
    ],
  });
  const base = {
    'GET /api/admin/questions': () => jsonResponse({ items: [question('q1', 0), question('q2', 3)], total: 2, page: 1, pageSize: 20 }),
    'GET /api/admin/questions/pool-summary': () => jsonResponse({ pools: [], sections: ['A', 'B', 'C', 'D', 'E', 'F', 'SQL'] }),
    'GET /api/admin/domains': () => jsonResponse(DOMAINS),
  };
  const impact = [{ paperId: 'p1', paperName: 'AI Round 1', domain: 'AI/ML', section: 'F', sectionTitle: 'Statistics', required: 5, available: 5, remaining: 4 }];

  it('permanently deletes a question used in assessments (no archive substitute) and explains what is kept', async () => {
    const calls: string[] = [];
    mockFetch({
      ...base,
      'GET /api/admin/questions/q2/removal-preview': () => jsonResponse({ usedInSessions: 3, inProgress: 1, impact }),
      'DELETE /api/admin/questions/q2': () => {
        calls.push('DELETE');
        return jsonResponse({ outcome: 'deleted' });
      },
      'POST /api/admin/questions/q2/archive': () => {
        calls.push('ARCHIVE');
        return jsonResponse({ outcome: 'archived' });
      },
    });
    renderAdmin('/admin/question-bank', '/admin/question-bank', <QuestionBankPage />);
    const sectionFilter = await screen.findByLabelText('Section');
    await waitFor(() => expect(within(sectionFilter).getByRole('option', { name: 'Section SQL' })).toBeInTheDocument());

    await userEvent.click((await screen.findAllByRole('button', { name: 'Permanently delete question' }))[1]!);
    const dialog = await screen.findByRole('dialog', { name: 'Permanently delete question?' });
    expect(await within(dialog).findByText('Used in 3 assessment(s)')).toBeInTheDocument();
    expect(within(dialog).getByText(/answers, marks and reports are kept/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 of them is still in progress/)).toBeInTheDocument();
    expect(within(dialog).getByText(/no longer be available for future assignments/)).toBeInTheDocument();
    // An affected active paper is a warning, not a block, and is never deactivated.
    expect(within(dialog).getByText('Active paper will have an insufficient question pool')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Edit paper' })).toHaveAttribute('href', '/admin/question-papers/p1');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Permanently delete question' }));
    await waitFor(() => expect(calls).toEqual(['DELETE']));
    expect(await screen.findByText('Question permanently deleted')).toBeInTheDocument();
  });

  it('shows the error and no success message when deletion fails', async () => {
    mockFetch({
      ...base,
      'GET /api/admin/questions/q1/removal-preview': () => jsonResponse({ usedInSessions: 0, inProgress: 0, impact: [] }),
      'DELETE /api/admin/questions/q1': () => jsonResponse({ error: { code: 'INTERNAL', message: 'Database unavailable' } }, 500),
    });
    renderAdmin('/admin/question-bank', '/admin/question-bank', <QuestionBankPage />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Permanently delete question' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Permanently delete question?' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Permanently delete question' }));
    expect(await within(dialog).findByText('Database unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Question permanently deleted')).toBeNull();
  });

  it('Delete all questions shows the scope and total, and the confirmation performs a permanent delete', async () => {
    const posts: unknown[] = [];
    mockFetch({
      ...base,
      'GET /api/admin/questions/bulk-delete/preview': () =>
        jsonResponse({ scope: 'domain', label: 'AI/ML', total: 40, usedInAssessments: 12, previouslyArchived: 2, activePapers: [{ id: 'p1', name: 'AI Round 1', domain: 'AI/ML' }], impact: { delete: impact, archive: impact } }),
      'POST /api/admin/questions/bulk-delete': (init) => {
        posts.push(body(init));
        return jsonResponse({ mode: 'delete', label: 'AI/ML', deleted: 42, archived: 0, usedInAssessments: 12 });
      },
    });
    renderAdmin('/admin/question-bank', '/admin/question-bank', <QuestionBankPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete all questions' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete all questions' });
    expect(within(dialog).getByText(/Choose one domain, or explicitly choose the entire question bank/)).toBeInTheDocument();

    await userEvent.selectOptions(within(dialog).getByLabelText(/^Scope/), 'ai-ml');
    expect(await within(dialog).findByText('Scope: AI/ML · 40 questions in the question bank')).toBeInTheDocument();
    expect(within(dialog).getByText(/12 of them were used in assessments/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 previously archived questions in this scope will also be deleted/)).toBeInTheDocument();
    expect(within(dialog).getByText(/It is not deactivated/)).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Permanently delete all questions/ })).toBeChecked();

    // An active paper using these questions is a warning, never a blocker: the button is enabled.
    expect(within(dialog).getByText('Active paper will have an insufficient question pool')).toBeInTheDocument();
    expect(within(dialog).getByText(/This does not block the deletion/)).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Permanently delete 42 questions' });
    expect(go).toBeEnabled();
    // Clicking without the typed confirmation explains what is needed and sends nothing.
    await userEvent.click(go);
    expect(within(dialog).getByText('Type DELETE in the box above to confirm.')).toBeInTheDocument();
    expect(posts).toHaveLength(0);
    await userEvent.type(within(dialog).getByLabelText(/Type DELETE to confirm/), 'DELETE');
    await userEvent.click(go);
    await waitFor(() => expect(posts).toEqual([{ scope: 'domain', domainSlug: 'ai-ml', mode: 'delete', confirm: 'DELETE' }]));
    expect(await screen.findByText('42 questions permanently deleted from AI/ML')).toBeInTheDocument();
  });

  it('Delete all reports a failure without claiming success', async () => {
    mockFetch({
      ...base,
      'GET /api/admin/questions/bulk-delete/preview': () =>
        jsonResponse({ scope: 'all', label: 'all domains', total: 5, usedInAssessments: 0, previouslyArchived: 0, activePapers: [], impact: { delete: [], archive: [] } }),
      'POST /api/admin/questions/bulk-delete': () => jsonResponse({ error: { code: 'INTERNAL', message: 'Database unavailable' } }, 500),
    });
    renderAdmin('/admin/question-bank', '/admin/question-bank', <QuestionBankPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete all questions' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete all questions' });
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Scope/), 'All domains (entire question bank)');
    await userEvent.type(await within(dialog).findByLabelText(/Type DELETE to confirm/), 'DELETE');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Permanently delete 5 questions' }));
    expect(await screen.findByText('Nothing was changed')).toBeInTheDocument();
    expect(screen.queryByText(/permanently deleted from/)).toBeNull();
  });

  it('keeps the delete button enabled when the preview lacks optional counts (no NaN)', async () => {
    mockFetch({
      ...base,
      // Only the essentials, as an older server would send.
      'GET /api/admin/questions/bulk-delete/preview': () => jsonResponse({ scope: 'domain', label: 'AI/ML', total: 7, activePapers: [], impact: { delete: impact } }),
    });
    renderAdmin('/admin/question-bank', '/admin/question-bank', <QuestionBankPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete all questions' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete all questions' });
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Scope/), 'ai-ml');
    expect(await within(dialog).findByRole('button', { name: 'Permanently delete 7 questions' })).toBeEnabled();
    expect(within(dialog).getByLabelText(/Type DELETE to confirm/)).toBeInTheDocument();
  });
});

describe('PapersPage readiness line', () => {
  const paper = (id: string, name: string, isActive: boolean, sections: { key: string; questionCount: number; total: number }[]) => {
    const shortfalls = sections.filter((x) => x.questionCount > x.total).map((x) => ({ section: x.key, required: x.questionCount, available: x.total }));
    return {
      id,
      name,
      description: '',
      domain: { slug: 'ai-ml', name: 'AI/ML' },
      durationMinutes: 5,
      shuffleOptions: true,
      negativeMarkingEnabled: false,
      isActive,
      createdAt: '2026-10-03T06:00:00Z',
      updatedAt: '2026-10-03T06:00:00Z',
      totalQuestions: sections.reduce((n, x) => n + x.questionCount, 0),
      sessionCount: 0,
      activeSessionCount: 0,
      editable: true,
      sections: sections.map((x, i) => ({ key: x.key, title: `Section ${x.key}`, position: i + 1, questionCount: x.questionCount, marksPerQuestion: null, negativeMarksPerQuestion: null, available: { total: x.total, mcq: x.total, coding: 0 } })),
      shortfalls,
      ready: shortfalls.length === 0,
    };
  };

  it('shows what students experience: success only for an active ready paper, exact shortfalls otherwise', async () => {
    mockFetch({
      'GET /api/admin/papers': () =>
        jsonResponse({
          items: [
            paper('p1', 'AI/ML — Sample Campus Drive', true, [{ key: 'A', questionCount: 10, total: 1 }, { key: 'B', questionCount: 10, total: 0 }, { key: 'E', questionCount: 0, total: 0 }]),
            paper('p2', 'AI ML', false, [{ key: 'A', questionCount: 1, total: 1 }, { key: 'B', questionCount: 0, total: 0 }]),
            { ...paper('p3', 'Java Round 1', true, [{ key: 'A', questionCount: 2, total: 5 }]), domain: { slug: 'full-stack-java', name: 'Full Stack - Java' } },
            { ...paper('p4', 'Java Draft', false, [{ key: 'A', questionCount: 9, total: 5 }]), domain: { slug: 'full-stack-java', name: 'Full Stack - Java' } },
          ],
        }),
    });
    renderAdmin('/admin/question-papers', '/admin/question-papers', <PapersPage />);
    // Active and short: red, with section, required and available counts.
    expect((await screen.findByText('Insufficient question pool — new attempts are blocked. Section A: needs 10, 1 available; Section B: needs 10, 0 available')).parentElement).toHaveClass('text-red-700');
    // Inactive but ready: a warning naming the paper students actually get — never a plain success.
    const inactiveReady = screen.getByText(/Enough questions, but inactive: activate this paper to use it\. Students in AI\/ML currently get “AI\/ML — Sample Campus Drive”, which is not ready, so they cannot start\./);
    expect(inactiveReady.parentElement).toHaveClass('text-amber-700');
    expect(screen.queryByText(/^Enough active questions$/)).toBeNull();
    // Active and ready: the only green success.
    expect(screen.getByText('Enough active questions — students can start this paper').parentElement).toHaveClass('text-emerald-700');
    // Inactive and short.
    expect(screen.getByText('Not ready. Section A: needs 9, 5 available').parentElement).toHaveClass('text-red-700');
  });
});

describe('PapersPage activate / deactivate from the list', () => {
  const paperRec = (id: string, name: string, slug: string, isActive: boolean) => ({
    id,
    name,
    description: '',
    domain: { slug, name: slug === 'ai-ml-ds' ? 'AI/ML/DS' : 'AI/ML' },
    durationMinutes: 15,
    shuffleOptions: true,
    negativeMarkingEnabled: false,
    isActive,
    createdAt: '2026-10-03T06:00:00Z',
    updatedAt: '2026-10-03T06:00:00Z',
    totalQuestions: 4,
    sessionCount: 0,
    activeSessionCount: 0,
    editable: true,
    sections: [{ key: 'A', title: 'Section A', position: 1, questionCount: 1, marksPerQuestion: null, negativeMarksPerQuestion: null, available: { total: 3, mcq: 3, coding: 0 } }],
    shortfalls: [],
    ready: true,
  });

  it('activates an inactive paper after confirmation and shows the new status', async () => {
    const db = [paperRec('p1', 'AI/ML/DS', 'ai-ml-ds', false)];
    const patches: unknown[] = [];
    mockFetch({
      'GET /api/admin/papers': () => jsonResponse({ items: db }),
      'PATCH /api/admin/papers/p1/active': (init) => {
        patches.push(body(init));
        db[0] = { ...db[0]!, isActive: true };
        return jsonResponse({ paper: db[0], deactivated: [] });
      },
    });
    renderAdmin('/admin/question-papers', '/admin/question-papers', <PapersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Activate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate “AI/ML/DS”?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(patches).toEqual([{ isActive: true }]));
    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows the server’s exact reason when activation is refused', async () => {
    mockFetch({
      'GET /api/admin/papers': () => jsonResponse({ items: [paperRec('p1', 'AI/ML/DS', 'ai-ml-ds', false)] }),
      'PATCH /api/admin/papers/p1/active': () =>
        jsonResponse({ error: { code: 'INSUFFICIENT_QUESTIONS', message: 'Cannot activate "AI/ML/DS": not enough eligible questions in AI/ML/DS — Section B needs 2, 1 available.' } }, 422),
    });
    renderAdmin('/admin/question-papers', '/admin/question-papers', <PapersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Activate' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Activate “AI/ML/DS”?' })).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/Section B needs 2, 1 available/)).toBeInTheDocument();
  });
});

