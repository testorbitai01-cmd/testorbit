import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@test-orbit/shared';
import { ToastProvider } from '@/components/ui/Toast';
import { releaseMedia } from '@/services/media';
import { jsonResponse, mockFetch } from '@/test/utils';
import { AssessmentPage } from './AssessmentPage';

// Face-detector runtime is unavailable in jsdom: the page must keep working and report it.
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: () => Promise.reject(new Error('no WebAssembly in test')) },
  FaceDetector: { createFromOptions: vi.fn() },
}));

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  label = 'Fake device';
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
}
function fakeStream(track: FakeTrack) {
  return { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}

const view = {
  serverNow: new Date().toISOString(),
  session: { id: 's1', status: 'IN_PROGRESS', statusLabel: 'In progress', startedAt: null, deadlineAt: null, remainingMs: 40 * 60_000, durationMinutes: 45, lastQuestionPosition: 1, terminationReason: null },
  student: { fullName: 'Asha Kumar', registrationNumber: 'REG1', domainName: 'AI/ML' },
  paper: { name: 'Paper' },
  sections: [{ key: 'A', title: 'Section A', count: 1 }],
  questions: [
    { id: 'q1', position: 1, section: 'A', sectionTitle: 'Section A', sectionPosition: 1, type: 'MCQ', text: 'What is 2 + 2?', marks: 1, negativeMarks: 0, options: [{ id: 'o1', text: 'Three' }, { id: 'o2', text: 'Four' }] },
  ],
  answers: {},
  proctoring: { eventRules: DEFAULT_SETTINGS.proctoring.eventRules, monitoring: DEFAULT_SETTINGS.proctoring.monitoring, warnings: { TAB_SWITCH: 0, GENERAL: 0 } },
  heartbeatIntervalSeconds: 20,
};

let tracks: FakeTrack[] = [];
let fetchMock: ReturnType<typeof mockFetch>;

beforeEach(() => {
  tracks = [];
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        const t = new FakeTrack();
        tracks.push(t);
        return fakeStream(t);
      }),
    },
  });
  vi.stubGlobal('AudioContext', undefined);
  let tabSwitches = 0;
  fetchMock = mockFetch({
    'GET /api/assessment/s1': () => jsonResponse(view),
    'POST /api/assessment/s1/heartbeat': () => jsonResponse({ serverNow: new Date().toISOString(), session: view.session }),
    // Mirrors the server's default policy: 1 tab-switch warning, the 2nd switch terminates.
    'POST /api/assessment/s1/events': (init) => {
      const body = JSON.parse(String(init?.body));
      const recordedAt = new Date().toISOString();
      if (body.type === 'TAB_HIDDEN') {
        tabSwitches += 1;
        return tabSwitches === 1
          ? jsonResponse({ action: 'WARNING', warningNumber: 1, maxWarnings: 1, ruleGroup: 'TAB_SWITCH', eventCount: 1, status: 'IN_PROGRESS', recordedAt })
          : jsonResponse({ action: 'TERMINATED', warningNumber: null, maxWarnings: 1, ruleGroup: 'TAB_SWITCH', eventCount: 2, status: 'FLAGGED_FOR_REVIEW', recordedAt });
      }
      const group = view.proctoring.eventRules[body.type as 'TAB_HIDDEN'];
      return jsonResponse({ action: group === 'LOG_ONLY' ? 'LOGGED' : 'WARNING', warningNumber: 1, maxWarnings: group === 'GENERAL' ? 2 : null, ruleGroup: group, eventCount: 1, status: 'IN_PROGRESS', recordedAt });
    },
    'POST /api/assessment/s1/events/acknowledge': (init) => jsonResponse({ acknowledged: JSON.parse(String(init?.body)).clientEventIds.length }),
    'POST /api/assessment/s1/answers': (init) => {
      const b = JSON.parse(String(init?.body));
      return jsonResponse({ applied: true, sessionQuestionId: b.sessionQuestionId, clientSeq: b.clientSeq, savedAt: new Date().toISOString() });
    },
  });
});

afterEach(() => {
  releaseMedia();
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

function renderExam() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/assessment/s1']}>
          <Routes>
            <Route path="/assessment/:sessionId" element={<AssessmentPage />} />
            <Route path="/session-status" element={<p>SESSION STATUS PAGE</p>} />
            <Route path="/assessment/:sessionId/submitted" element={<p>SUBMITTED PAGE</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const bodies = () => fetchMock.mock.calls.map(([, init]) => init?.body).filter((b) => b !== undefined);
const sent = (type: string) => bodies().some((b) => typeof b === 'string' && b.includes(`"type":"${type}"`));

describe('Assessment page proctoring', () => {
  it('shows "warning 1 of 1" for the first tab switch while the assessment continues', async () => {
    renderExam();
    expect(await screen.findByText('What is 2 + 2?')).toBeInTheDocument();
    await waitFor(() => expect(tracks.length).toBe(2)); // camera + microphone acquired

    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    const alerts = await screen.findAllByText(/Tab switch detected/);
    expect(alerts.length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Warning 1 of 1')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Final warning: if you switch tabs again/).length).toBeGreaterThan(0);
    // The question stays usable and autosave still works.
    await userEvent.click(screen.getByText('Four'));
    await waitFor(() => expect(bodies().some((b) => typeof b === 'string' && b.includes('"selectedOptionId":"o2"'))).toBe(true));
    expect(screen.queryByText('SESSION STATUS PAGE')).not.toBeInTheDocument();
    expect(screen.queryByText('SUBMITTED PAGE')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/submit'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('sign-out'))).toBe(false);

    // Monitoring that cannot start is reported (metadata only) and the student is told.
    await waitFor(() => expect(sent('CAMERA_MONITORING_UNAVAILABLE')).toBe(true));
    await waitFor(() => expect(sent('MICROPHONE_MONITORING_UNAVAILABLE')).toBe(true));
    expect(screen.getAllByText(/monitoring could not start on this device/).length).toBeGreaterThan(0);
  });

  it('moves the student to the session-status page when the second tab switch terminates the session', async () => {
    renderExam();
    await screen.findByText('What is 2 + 2?');
    const tabSwitch = () =>
      act(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      });
    tabSwitch();
    await screen.findAllByText('Warning 1 of 1');
    tabSwitch();
    expect(await screen.findByText('SESSION STATUS PAGE')).toBeInTheDocument();
    // Terminated, not submitted, and camera/microphone released.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/submit'))).toBe(false);
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
  });

  it('acknowledges a dismissed warning', async () => {
    renderExam();
    await screen.findByText('What is 2 + 2?');
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const dismiss = (await screen.findAllByRole('button', { name: /Dismiss warning: Tab switch detected/ }))[0]!;
    await userEvent.click(dismiss);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/events/acknowledge'))).toBe(true));
  });

  it('warns about a disconnected camera without blocking the question', async () => {
    renderExam();
    await screen.findByText('What is 2 + 2?');
    await waitFor(() => expect(tracks.length).toBe(2));
    act(() => {
      tracks[0]!.readyState = 'ended';
      tracks[0]!.dispatchEvent(new Event('ended'));
    });
    expect((await screen.findAllByText(/Camera disconnected/)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Reconnect/ }).length).toBeGreaterThan(0);
    expect(screen.getByText('Four')).toBeVisible();
    await waitFor(() => expect(sent('CAMERA_DISCONNECTED')).toBe(true));
  });

  it('never sends media and stops every camera/microphone track on unmount', async () => {
    const { unmount } = renderExam();
    await screen.findByText('What is 2 + 2?');
    await waitFor(() => expect(tracks.length).toBe(2));
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(sent('TAB_HIDDEN')).toBe(true));
    for (const b of bodies()) {
      expect(typeof b).toBe('string'); // JSON metadata only — no Blob/FormData/ArrayBuffer
      expect(b as string).not.toMatch(/data:|base64|image\/|audio\//i);
      expect((b as string).length).toBeLessThan(4096);
    }
    unmount();
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
  });
});
