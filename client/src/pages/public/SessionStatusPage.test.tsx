import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/Toast';
import { SessionStatusPage } from '@/pages/public/SessionStatusPage';
import { jsonResponse, mockFetch } from '@/test/utils';

afterEach(() => vi.unstubAllGlobals());

/** The sign-in dialog sends a returning student here with the server's message and session status. */
function renderFromSignIn(state: { message: string; status: string }) {
  mockFetch({ 'GET /api/students/me': () => jsonResponse({ error: { code: 'STUDENT_UNAUTHENTICATED', message: 'x' } }, 401) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[{ pathname: '/session-status', state }]}>
          <SessionStatusPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('SessionStatusPage after sign-in', () => {
  it('a submitted assessment shows the submitted message and no resume-code form', async () => {
    renderFromSignIn({ status: 'SUBMITTED', message: 'Your assessment has already been submitted. It cannot be resumed or taken again.' });
    expect(await screen.findByText(/already been submitted\. It cannot be resumed/)).toBeInTheDocument();
    expect(screen.queryByText('Resume with a code')).toBeNull();
    expect(screen.queryByLabelText(/Resume code/)).toBeNull();
  });

  it('a paused assessment still offers the resume-code form', async () => {
    renderFromSignIn({ status: 'FLAGGED_FOR_REVIEW', message: 'Your assessment has already been started. To continue, contact the placement/test support team for a resume code.' });
    expect(await screen.findByText('Resume with a code')).toBeInTheDocument();
    expect(screen.getByLabelText(/Resume code/)).toBeInTheDocument();
  });
});
