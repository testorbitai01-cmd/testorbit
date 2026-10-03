import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@test-orbit/shared';
import { DomainsPage } from '@/pages/admin/DomainsPage';
import { PaperDetailPage } from '@/pages/admin/PaperDetailPage';
import { QuestionBankPage } from '@/pages/admin/QuestionBankPage';
import { SettingsPage } from '@/pages/admin/SettingsPage';
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

function renderAdmin(path: string, pattern: string, element: React.ReactNode) {
  return renderWithProviders(
    <Routes>
      <Route element={<Outlet context={ADMIN} />}>
        <Route path={pattern} element={element} />
      </Route>
    </Routes>,
    { route: path },
  );
}

const body = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? '{}'));
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
  assessmentCount: 0,
  ...extra,
});
const DOMAINS = { items: [domainRow('ai-ml', 'AI/ML')] };

// ───────────────────────────── Settings → Question Paper Defaults ─────────────────────────────

describe('Settings: Question Paper Defaults', () => {
  const base = (defaults: object) => ({
    'GET /api/admin/settings': () => jsonResponse({ settings: DEFAULT_SETTINGS, photoStorage: { driver: 'local', enabled: true } }),
    'GET /api/admin/settings/admins': () => jsonResponse({ items: [] }),
    'GET /api/admin/settings/paper-defaults': () => jsonResponse({ paperDefaults: defaults }),
  });

  it('shows the saved values, validates them, and saves only the defaults', async () => {
    let saved = { durationMinutes: 15, sectionCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 } };
    const puts: unknown[] = [];
    mockFetch({
      ...base(saved),
      'GET /api/admin/settings/paper-defaults': () => jsonResponse({ paperDefaults: saved }),
      'PUT /api/admin/settings/paper-defaults': (init) => {
        puts.push(body(init));
        saved = body(init);
        return jsonResponse({ paperDefaults: saved });
      },
    });
    renderAdmin('/admin/settings', '/admin/settings', <SettingsPage />);
    const duration = await screen.findByLabelText(/^Default duration \(minutes\)/);
    expect(duration).toHaveValue(15);
    expect(screen.getByLabelText(/^Section A questions/)).toHaveValue(1);
    expect(screen.getByLabelText(/^Section E questions/)).toHaveValue(0);
    expect(screen.getByText('New papers will start with 1 question in total.')).toBeInTheDocument();

    // Invalid: empty duration is not turned into 0, and nothing is sent.
    await userEvent.clear(duration);
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    expect(await screen.findByText('Duration must be a whole number')).toBeInTheDocument();
    expect(puts).toHaveLength(0);

    await userEvent.type(duration, '45');
    for (const [k, v] of Object.entries({ A: '10', B: '10', C: '10', D: '5', E: '5' })) {
      const input = screen.getByLabelText(new RegExp(`^Section ${k} questions`));
      await userEvent.clear(input);
      await userEvent.type(input, v);
    }
    expect(screen.getByText('New papers will start with 40 questions in total.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(puts).toEqual([{ durationMinutes: 45, sectionCounts: { A: 10, B: 10, C: 10, D: 5, E: 5 } }]));
    expect(await screen.findByText('Question paper defaults saved')).toBeInTheDocument();
  });

  it('shows the server’s validation message when a value is rejected', async () => {
    mockFetch({
      ...base({ durationMinutes: 15, sectionCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 } }),
      'PUT /api/admin/settings/paper-defaults': () =>
        jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: { fieldErrors: { durationMinutes: 'Duration must be at most 300' } } } }, 400),
    });
    renderAdmin('/admin/settings', '/admin/settings', <SettingsPage />);
    await screen.findByLabelText(/^Default duration/);
    await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    expect(await screen.findByText('Duration must be at most 300')).toBeInTheDocument();
    expect(screen.getByText('Could not save question paper defaults')).toBeInTheDocument();
  });
});

// ───────────────────────────── New paper form ─────────────────────────────

describe('New question paper form uses the saved defaults', () => {
  const pools = { pools: ['A', 'B', 'C', 'D', 'E'].map((section) => ({ domain: 'ai-ml', section, type: 'MCQ', count: 30 })), sections: ['A', 'B', 'C', 'D', 'E'] };

  it('pre-fills duration and section counts from Settings, and the paper can override them', async () => {
    const posts: { durationMinutes: number | string; sections: { key: string; questionCount: number | string }[] }[] = [];
    mockFetch({
      'GET /api/admin/domains': () => jsonResponse(DOMAINS),
      'GET /api/admin/questions/pool-summary': () => jsonResponse(pools),
      'GET /api/admin/papers': () => jsonResponse({ items: [] }),
      'GET /api/admin/settings/paper-defaults': () => jsonResponse({ paperDefaults: { durationMinutes: 45, sectionCounts: { A: 2, B: 1, C: 2, D: 1, E: 2 } } }),
      'POST /api/admin/papers': (init) => {
        posts.push(body(init));
        return jsonResponse({ error: { code: 'X', message: 'stop' } }, 409);
      },
    });
    renderAdmin('/admin/question-papers/new', '/admin/question-papers/:paperId', <PaperDetailPage />);
    const duration = await screen.findByLabelText(/^Duration \(minutes\)/);
    expect(duration).toHaveValue(45);
    expect(screen.getByText('8 questions in total')).toBeInTheDocument();

    // Override for this paper only.
    await userEvent.clear(duration);
    await userEvent.type(duration, '30');
    await userEvent.type(screen.getByLabelText(/^Paper name/), 'Campus drive');
    await userEvent.click(screen.getByRole('button', { name: 'Create paper' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(Number(posts[0]!.durationMinutes)).toBe(30);
    expect(posts[0]!.sections.map((s) => [s.key, Number(s.questionCount)])).toEqual([['A', 2], ['B', 1], ['C', 2], ['D', 1], ['E', 2]]);
  });

  it('does not show the form with built-in values when the defaults cannot be loaded', async () => {
    mockFetch({
      'GET /api/admin/domains': () => jsonResponse(DOMAINS),
      'GET /api/admin/questions/pool-summary': () => jsonResponse(pools),
      'GET /api/admin/papers': () => jsonResponse({ items: [] }),
      'GET /api/admin/settings/paper-defaults': () => jsonResponse({ error: { code: 'INTERNAL', message: 'Settings unavailable' } }, 500),
    });
    renderAdmin('/admin/question-papers/new', '/admin/question-papers/:paperId', <PaperDetailPage />);
    expect(await screen.findByText(/Settings unavailable/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Duration \(minutes\)/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create paper' })).toBeNull();
  });
});

// ───────────────────────────── Question changes: readiness warning ─────────────────────────────

describe('Question bank: readiness warning before a harmful change', () => {
  const question = {
    id: 'q1',
    domain: { slug: 'ai-ml', name: 'AI/ML' },
    section: 'A',
    type: 'MCQ',
    text: 'What is overfitting?',
    marks: 1,
    negativeMarks: 0,
    difficulty: 'EASY',
    explanation: null,
    isActive: true,
    externalRef: null,
    usageCount: 0,
    createdAt: '',
    updatedAt: '',
    options: [
      { id: 'o1', text: 'Yes', isCorrect: true, position: 1 },
      { id: 'o2', text: 'No', isCorrect: false, position: 2 },
    ],
  };
  const impact = [{ paperId: 'p1', paperName: 'AI Round 1', domain: 'AI/ML', section: 'A', sectionTitle: 'Section A', required: 1, available: 1, remaining: 0 }];
  const readinessError = () => jsonResponse({ error: { code: 'READINESS_IMPACT', message: 'This change would leave an active question paper without enough eligible questions', details: { impact } } }, 409);
  const base = {
    'GET /api/admin/questions': () => jsonResponse({ items: [question], total: 1, page: 1, pageSize: 20 }),
    'GET /api/admin/questions/pool-summary': () => jsonResponse({ pools: [], sections: ['A', 'B'] }),
    'GET /api/admin/domains': () => jsonResponse({ items: [domainRow('ai-ml', 'AI/ML'), domainRow('data-analytics', 'Data Analytics')] }),
  };

  it('deactivating: shows paper, domain and section counts; Cancel sends nothing more; Confirm applies with acknowledgement', async () => {
    const patches: unknown[] = [];
    mockFetch({
      ...base,
      'PATCH /api/admin/questions/q1/active': (init) => {
        const b = body(init);
        patches.push(b);
        return b.acknowledgeReadinessImpact ? jsonResponse({ ...question, isActive: false }) : readinessError();
      },
    });
    renderAdmin('/admin/question-bank', '/admin/question-bank', <QuestionBankPage />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Question active' }));
    let dialog = await screen.findByRole('dialog', { name: 'This change affects an active paper' });
    expect(within(dialog).getByText(/AI Round 1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/\(AI\/ML\), section A “Section A”: needs 1, 1 eligible now, 0 would remain\./)).toBeInTheDocument();
    expect(within(dialog).getByText(/the active paper may become unavailable/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(patches).toEqual([{ isActive: false }]);

    await userEvent.click(screen.getByRole('switch', { name: 'Question active' }));
    dialog = await screen.findByRole('dialog', { name: 'This change affects an active paper' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply change anyway' }));
    await waitFor(() => expect(patches).toEqual([{ isActive: false }, { isActive: false }, { isActive: false, acknowledgeReadinessImpact: true }]));
  });

  it('editing the domain: the warning appears before saving and Confirm resends with acknowledgement', async () => {
    const puts: { domainSlug: string; acknowledgeReadinessImpact?: boolean }[] = [];
    mockFetch({
      ...base,
      'PUT /api/admin/questions/q1': (init) => {
        const b = body(init);
        puts.push(b);
        return b.acknowledgeReadinessImpact ? jsonResponse({ ...question, domain: { slug: 'data-analytics', name: 'Data Analytics' } }) : readinessError();
      },
    });
    renderAdmin('/admin/question-bank', '/admin/question-bank', <QuestionBankPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit question' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit question' });
    await userEvent.selectOptions(within(edit).getByLabelText(/^Domain/), 'data-analytics');
    await userEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));
    const warn = await screen.findByRole('dialog', { name: 'This change affects an active paper' });
    expect(puts).toHaveLength(1);
    await userEvent.click(within(warn).getByRole('button', { name: 'Apply change anyway' }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toMatchObject({ domainSlug: 'data-analytics', acknowledgeReadinessImpact: true });
    expect(await screen.findByText('Question updated')).toBeInTheDocument();
  });
});

// ───────────────────────────── Domains page status ─────────────────────────────

describe('Domains page status', () => {
  it('distinguishes no active paper, a ready paper and a paper that is not ready (with shortfalls)', async () => {
    mockFetch({
      'GET /api/admin/domains': () =>
        jsonResponse({
          items: [
            domainRow('ai-ml', 'AI/ML', { activePaper: { id: 'p1', name: 'AI/ML — Sample Campus Drive', ready: false, shortfalls: [{ section: 'A', required: 10, available: 1 }, { section: 'B', required: 10, available: 0 }] } }),
            domainRow('ai-ml-ds', 'AI/ML/DS', { activePaper: { id: 'p2', name: 'AI/ML/DS', ready: true, shortfalls: [] } }),
            domainRow('digital-marketing', 'Digital Marketing'),
          ],
        }),
    });
    renderAdmin('/admin/domains', '/admin/domains', <DomainsPage />);
    expect(await screen.findByText('Active Paper — Not Ready')).toBeInTheDocument();
    expect(screen.getByText(/Section A needs 10, 1 available; Section B needs 10, 0 available\./)).toBeInTheDocument();
    expect(screen.getByText('Active Paper — Ready')).toBeInTheDocument();
    expect(screen.getByText('No Active Paper')).toBeInTheDocument();
    expect(screen.queryByText(/^Active paper$/)).toBeNull();
  });
});

// ───────────────────────────── Question status in the dashboard ─────────────────────────────

describe('Question bank: Active/Inactive status managed from the dashboard', () => {
  const make = (id: string, text: string, isActive: boolean) => ({
    id,
    domain: { slug: 'ai-ml', name: 'AI/ML' },
    section: 'A',
    type: 'MCQ',
    text,
    marks: 1,
    negativeMarks: 0,
    difficulty: 'EASY',
    explanation: null,
    isActive,
    externalRef: null,
    usageCount: 0,
    createdAt: '',
    updatedAt: '',
    options: [
      { id: `${id}-o1`, text: 'Yes', isCorrect: true, position: 1 },
      { id: `${id}-o2`, text: 'No', isCorrect: false, position: 2 },
    ],
  });

  it('shows active and inactive questions, and reflects a toggle and a new question from the server right away', async () => {
    // The fake server holds the state; the page must re-read it after each change.
    const db = [make('q1', 'Active question?', true), make('q2', 'Inactive question?', false)];
    let listCalls = 0;
    const patches: unknown[] = [];
    mockFetch({
      'GET /api/admin/questions': () => {
        listCalls += 1;
        return jsonResponse({ items: db, total: db.length, page: 1, pageSize: 20 });
      },
      'GET /api/admin/questions/pool-summary': () => jsonResponse({ pools: [], sections: ['A'] }),
      'GET /api/admin/domains': () => jsonResponse({ items: [domainRow('ai-ml', 'AI/ML')] }),
      'PATCH /api/admin/questions/q2/active': (init) => {
        patches.push(body(init));
        db[1] = { ...db[1]!, isActive: true };
        return jsonResponse(db[1]);
      },
      'POST /api/admin/questions': (init) => {
        const b = body(init);
        db.push(make('q3', b.text, true));
        return jsonResponse(db[2], 201);
      },
    });
    renderAdmin('/admin/question-bank', '/admin/question-bank', <QuestionBankPage />);

    const row = (text: string) => screen.getByText(text).closest('tr')!;
    await screen.findByText('Inactive question?');
    expect(within(row('Active question?')).getByText('Active')).toBeInTheDocument();
    expect(within(row('Inactive question?')).getByText('Inactive')).toBeInTheDocument();
    expect(within(row('Inactive question?')).getByRole('switch', { name: 'Question active' })).toHaveAttribute('aria-checked', 'false');

    // Activate from the dashboard.
    const before = listCalls;
    await userEvent.click(within(row('Inactive question?')).getByRole('switch', { name: 'Question active' }));
    await waitFor(() => expect(within(row('Inactive question?')).getByText('Active')).toBeInTheDocument());
    expect(patches).toEqual([{ isActive: true }]);
    expect(listCalls).toBeGreaterThan(before); // re-read from the server, not just flipped locally

    // Create manually through the form.
    await userEvent.click(screen.getByRole('button', { name: 'New question' }));
    const dialog = await screen.findByRole('dialog', { name: 'New question' });
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Domain/), 'ai-ml');
    await userEvent.type(within(dialog).getByLabelText(/^Question text/), 'A manually entered question?');
    for (const [i, t] of ['First', 'Second', 'Third', 'Fourth'].entries()) await userEvent.type(within(dialog).getByLabelText(`Option ${String.fromCharCode(65 + i)}`), t);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create question' }));
    expect(await screen.findByText('A manually entered question?')).toBeInTheDocument();
    expect(within(row('A manually entered question?')).getByText('Active')).toBeInTheDocument();
  });
});
