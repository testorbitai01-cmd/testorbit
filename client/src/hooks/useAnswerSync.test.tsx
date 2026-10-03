import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, mockFetch } from '@/test/utils';
import { useAnswerSync } from './useAnswerSync';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ok = (init?: RequestInit) => {
  const b = JSON.parse(String(init?.body));
  return jsonResponse({ applied: true, sessionQuestionId: b.sessionQuestionId, clientSeq: b.clientSeq, savedAt: new Date().toISOString() });
};

describe('useAnswerSync', () => {
  it('saves MCQ answers immediately and reports "saved" only after the server confirms', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = mockFetch({
      'POST /api/assessment/s1/answers': async (init) => {
        await gate;
        return ok(init);
      },
    });
    const { result } = renderHook(() => useAnswerSync('s1', {}, () => undefined));
    act(() => result.current.setMcqAnswer('q1', 'o2'));
    await waitFor(() => expect(result.current.states.q1).toBe('saving'));
    expect(result.current.answers.q1).toEqual({ selectedOptionId: 'o2', answerText: null });
    release();
    await waitFor(() => expect(result.current.states.q1).toBe('saved'));
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ sessionQuestionId: 'q1', selectedOptionId: 'o2' });
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ 'x-test-orbit-request': '1' });
  });

  it('sends increasing sequence numbers and coalesces edits while a save is in flight', async () => {
    const bodies: { selectedOptionId: string; clientSeq: number }[] = [];
    let first = true;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    mockFetch({
      'POST /api/assessment/s1/answers': async (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (first) {
          first = false;
          await gate;
        }
        return ok(init);
      },
    });
    const { result } = renderHook(() => useAnswerSync('s1', { q1: { selectedOptionId: 'o1', answerText: null, clientSeq: 9_999_999_999_999, savedAt: '' } }, () => undefined));
    act(() => result.current.setMcqAnswer('q1', 'o2'));
    act(() => result.current.setMcqAnswer('q1', 'o3'));
    act(() => result.current.setMcqAnswer('q1', 'o4'));
    releaseFirst();
    await waitFor(() => expect(result.current.states.q1).toBe('saved'));
    // Only the first and the latest edit are sent; seq continues above the stored one.
    expect(bodies.map((b) => b.selectedOptionId)).toEqual(['o2', 'o4']);
    expect(bodies[0]!.clientSeq).toBeGreaterThan(9_999_999_999_999);
    expect(bodies[1]!.clientSeq).toBeGreaterThan(bodies[0]!.clientSeq);
  });

  it('retries after a network failure and recovers', async () => {
    let calls = 0;
    mockFetch({
      'POST /api/assessment/s1/answers': (init) => {
        calls += 1;
        if (calls === 1) throw new TypeError('Failed to fetch');
        return ok(init);
      },
    });
    const { result } = renderHook(() => useAnswerSync('s1', {}, () => undefined));
    act(() => result.current.setMcqAnswer('q1', 'o1'));
    await waitFor(() => expect(result.current.states.q1).toBe('error'));
    expect(result.current.lastError).toMatch(/retried automatically/);
    // Coming back online retries immediately.
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(result.current.states.q1).toBe('saved'));
    expect(calls).toBe(2);
  });

  it('debounces coding answers and flush() sends them right away', async () => {
    const fetch = mockFetch({ 'POST /api/assessment/s1/answers': (init) => ok(init) });
    const { result } = renderHook(() => useAnswerSync('s1', {}, () => undefined));
    act(() => result.current.setTextAnswer('q9', 'def f():\n    return 1'));
    expect(fetch).not.toHaveBeenCalled();
    let flushed = false;
    await act(async () => {
      flushed = await result.current.flush(2000);
    });
    expect(flushed).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).answerText).toBe('def f():\n    return 1');
  });

  it('stops and notifies when the session is no longer active', async () => {
    mockFetch({ 'POST /api/assessment/s1/answers': () => jsonResponse({ error: { code: 'SESSION_NOT_ACTIVE', message: 'ended' } }, 409) });
    const ended = vi.fn();
    const { result } = renderHook(() => useAnswerSync('s1', {}, ended));
    act(() => result.current.setMcqAnswer('q1', 'o1'));
    await waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
  });
});
