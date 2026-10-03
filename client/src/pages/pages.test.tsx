import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeEditor } from '@/pages/assessment/CodeEditor';
import { DeviceCheckPage } from '@/pages/public/DeviceCheckPage';
import { InstructionsPage } from '@/pages/public/InstructionsPage';
import { RegisterPage } from '@/pages/public/RegisterPage';
import { jsonResponse, mockFetch, renderWithProviders } from '@/test/utils';

afterEach(() => vi.unstubAllGlobals());

const profile = {
  student: {
    id: 's1',
    fullName: 'Asha Kumar',
    registrationNumber: 'REG1',
    mobileNumber: '9876543210',
    collegeEmail: 'a@c.edu',
    personalEmail: 'a@g.com',
    collegeName: 'Orbit',
    location: 'Pune',
    department: 'CSE',
    yearOfPassing: 2026,
    domain: { slug: 'ai-ml', name: 'AI/ML' },
    domainLocked: false,
    education: [],
  },
  deviceCheck: { completed: false, completedAt: null, photoRequired: true, photoCaptured: false },
  session: null,
  nextStep: 'device-check',
};

describe('RegisterPage', () => {
  it('shows validation messages and does not submit an invalid form', async () => {
    const fetch = mockFetch({
      'GET /api/students/me': () => jsonResponse({ error: { code: 'STUDENT_UNAUTHENTICATED', message: 'x' } }, 401),
      'GET /api/students/domains': () => jsonResponse({ domains: [{ slug: 'ai-ml', name: 'AI/ML' }] }),
    });
    renderWithProviders(<RegisterPage />);
    await screen.findByRole('heading', { name: 'Student registration' });
    await userEvent.type(screen.getByLabelText(/College email address/), 'not-an-email');
    await userEvent.click(screen.getByLabelText(/I confirm these details are accurate/));
    await userEvent.click(screen.getByRole('button', { name: /Register and continue/ }));
    expect(await screen.findByText('Please correct the highlighted fields.')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid college email')).toBeInTheDocument();
    expect(screen.getByText('Select an assessment domain')).toBeInTheDocument();
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('keeps PG optional and reveals PG fields on demand', async () => {
    mockFetch({
      'GET /api/students/me': () => jsonResponse({ error: { code: 'x', message: 'x' } }, 401),
      'GET /api/students/domains': () => jsonResponse({ domains: [] }),
    });
    renderWithProviders(<RegisterPage />);
    await screen.findByRole('heading', { name: 'Student registration' });
    expect(screen.queryByText('Postgraduate Degree')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/I have a postgraduate degree/));
    expect(screen.getByText('Postgraduate Degree')).toBeInTheDocument();
  });
});

describe('DeviceCheckPage', () => {
  it('explains a denied camera/microphone permission and offers a retry', async () => {
    mockFetch({ 'GET /api/students/me': () => jsonResponse(profile) });
    const getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });

    renderWithProviders(<DeviceCheckPage />);
    await userEvent.click(await screen.findByRole('button', { name: /Allow camera & microphone/ }));
    await waitFor(() => expect(screen.getAllByText(/Permission was blocked/)).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue to instructions/ })).toBeDisabled();
    expect(getUserMedia).toHaveBeenCalledTimes(2); // camera and microphone requested separately
  });

  it('reports an unsupported browser', async () => {
    mockFetch({ 'GET /api/students/me': () => jsonResponse(profile) });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    renderWithProviders(<DeviceCheckPage />);
    expect(await screen.findByText(/does not support camera\/microphone access/)).toBeInTheDocument();
  });
});

describe('CodeEditor', () => {
  function Harness() {
    const [v, setV] = useState('if x:');
    return <CodeEditor label="Answer" value={v} onChange={setV} />;
  }
  it('keeps indentation, indents with Tab and preserves whitespace', async () => {
    renderWithProviders(<Harness />);
    const ta = screen.getByLabelText('Answer') as HTMLTextAreaElement;
    ta.setSelectionRange(5, 5);
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toBe('if x:\n    ');
    ta.setSelectionRange(ta.value.length, ta.value.length);
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(ta.value).toBe('if x:\n        ');
  });
});

describe('InstructionsPage', () => {
  const available = (paper: object | null) => ({
    domain: { slug: 'ai-ml', name: 'AI/ML' },
    checks: { registration: true, deviceCheck: true, identityPhoto: true },
    paper,
    proctoring: {
      tabSwitchMaxWarnings: 1,
      generalMaxWarnings: 2,
      eventRules: { TAB_HIDDEN: 'TAB_SWITCH' },
      faceDetectionEnabled: false,
      speechDetectionEnabled: false,
    },
    existingSession: null,
  });
  const atInstructions = { ...profile, deviceCheck: { ...profile.deviceCheck, completed: true }, nextStep: 'instructions' };

  it('shows the admin-configured total, per-section counts and duration (no fixed values)', async () => {
    mockFetch({
      'GET /api/students/me': () => jsonResponse(atInstructions),
      'GET /api/students/domains': () => jsonResponse({ domains: [{ slug: 'ai-ml', name: 'AI/ML' }] }),
      'GET /api/assessment/available-paper': () =>
        jsonResponse(
          available({
            name: 'AI ML Screening',
            description: '',
            durationMinutes: 20,
            totalQuestions: 8,
            negativeMarkingEnabled: false,
            sections: [
              { key: 'A', title: 'Aptitude', questionCount: 2 },
              { key: 'B', title: 'Python', questionCount: 1 },
              { key: 'C', title: 'Statistics', questionCount: 2 },
              { key: 'D', title: 'ML basics', questionCount: 1 },
              { key: 'E', title: 'Coding', questionCount: 2 },
            ],
          }),
        ),
    });
    renderWithProviders(<InstructionsPage />);
    expect(await screen.findByText('AI/ML · 8 questions · 20 minutes')).toBeInTheDocument();
    expect(screen.getByText(/The assessment lasts 20 minutes\./)).toBeInTheDocument();
    expect(screen.getByText(/There are 8 questions in 5 sections\./)).toBeInTheDocument();
    expect(screen.getByText('The 20-minute timer starts when you press Start Test.')).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem').filter((li) => /questions?$/.test(li.textContent ?? ''));
    expect(rows.map((li) => li.textContent)).toEqual(['Aptitude2 questions', 'Python1 question', 'Statistics2 questions', 'ML basics1 question', 'Coding2 questions']);
    expect(screen.queryByText(/\b(40|45)\b/)).toBeNull();
  });

  it('a one-question paper is described as such', async () => {
    mockFetch({
      'GET /api/students/me': () => jsonResponse(atInstructions),
      'GET /api/students/domains': () => jsonResponse({ domains: [{ slug: 'ai-ml', name: 'AI/ML' }] }),
      'GET /api/assessment/available-paper': () =>
        jsonResponse(available({ name: 'AI ML', description: '', durationMinutes: 5, totalQuestions: 1, negativeMarkingEnabled: false, sections: [{ key: 'A', title: 'Section A', questionCount: 1 }] })),
    });
    renderWithProviders(<InstructionsPage />);
    expect(await screen.findByText('AI/ML · 1 question · 5 minutes')).toBeInTheDocument();
    expect(screen.getByText(/There is 1 question in 1 section\./)).toBeInTheDocument();
    expect(screen.getByText(/The assessment lasts 5 minutes\./)).toBeInTheDocument();
  });

  it('a two-question paper is described as such', async () => {
    mockFetch({
      'GET /api/students/me': () => jsonResponse(atInstructions),
      'GET /api/students/domains': () => jsonResponse({ domains: [{ slug: 'ai-ml', name: 'AI/ML' }] }),
      'GET /api/assessment/available-paper': () =>
        jsonResponse(available({ name: 'AI ML', description: '', durationMinutes: 10, totalQuestions: 2, negativeMarkingEnabled: false, sections: [{ key: 'A', title: 'Section A', questionCount: 2 }] })),
    });
    renderWithProviders(<InstructionsPage />);
    expect(await screen.findByText('AI/ML · 2 questions · 10 minutes')).toBeInTheDocument();
    expect(screen.getByText(/There are 2 questions in 1 section\./)).toBeInTheDocument();
    expect(screen.getByText('The 10-minute timer starts when you press Start Test.')).toBeInTheDocument();
  });

  it('does not invent a duration or section count when no paper is open', async () => {
    mockFetch({
      'GET /api/students/me': () => jsonResponse(atInstructions),
      'GET /api/students/domains': () => jsonResponse({ domains: [{ slug: 'ai-ml', name: 'AI/ML' }] }),
      'GET /api/assessment/available-paper': () => jsonResponse(available(null)),
    });
    renderWithProviders(<InstructionsPage />);
    expect(await screen.findByText(/No assessment is open for AI\/ML yet/)).toBeInTheDocument();
    expect(screen.getByText(/^The assessment is timed\./)).toBeInTheDocument();
    expect(screen.queryByText(/\b(40|45) ?(minutes|questions)\b/)).toBeNull();
    expect(screen.queryByText(/5 sections/)).toBeNull();
  });
});

