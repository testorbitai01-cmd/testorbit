import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, mockFetch } from '@/test/utils';
import { useProctoring } from './useProctoring';

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function fakeTrack() {
  const t = new EventTarget() as EventTarget & { readyState: string; label: string };
  t.readyState = 'live';
  t.label = 'Fake camera';
  return t;
}

const sentTypes = (fetch: ReturnType<typeof mockFetch>) => fetch.mock.calls.map((c) => JSON.parse(String(c[1]!.body)).type);

describe('useProctoring', () => {
  it('reports a tab switch with a unique client event id and surfaces the server decision', async () => {
    const fetch = mockFetch({ 'POST /api/assessment/s1/events': () => jsonResponse({ action: 'WARNING', warningNumber: 1, eventCount: 1, ruleGroup: 'TAB_SWITCH', status: 'IN_PROGRESS' }) });
    const onResult = vi.fn();
    const onQueued = vi.fn();
    renderHook(() => useProctoring({ sessionId: 's1', enabled: true, videoTrack: null, audioTrack: null, onResult, onQueued, onDeviceLost: vi.fn() }));
    setHidden(true);
    // The UI is told immediately (before the network round-trip) so the warning can show even offline.
    expect(onQueued).toHaveBeenCalledWith(expect.objectContaining({ type: 'TAB_HIDDEN' }));
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.clientEventId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ action: 'WARNING' }), 'TAB_HIDDEN', body.clientEventId));
  });

  it('logs a page refresh/close as PAGE_UNLOAD instead of a tab switch', async () => {
    const fetch = mockFetch({ 'POST /api/assessment/s1/events': () => jsonResponse({ action: 'LOGGED', status: 'IN_PROGRESS' }) });
    renderHook(() => useProctoring({ sessionId: 's1', enabled: true, videoTrack: null, audioTrack: null, onResult: vi.fn(), onDeviceLost: vi.fn() }));
    window.dispatchEvent(new Event('pagehide'));
    setHidden(true);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(sentTypes(fetch)).toEqual(['PAGE_UNLOAD']);
    expect(fetch.mock.calls[0]![1]!.keepalive).toBe(true);
  });

  it('detects a camera track ending (permission revoked / unplugged)', async () => {
    const fetch = mockFetch({ 'POST /api/assessment/s1/events': () => jsonResponse({ action: 'WARNING', warningNumber: 1, status: 'IN_PROGRESS' }) });
    const track = fakeTrack();
    const onDeviceLost = vi.fn();
    renderHook(() => useProctoring({ sessionId: 's1', enabled: true, videoTrack: track as unknown as MediaStreamTrack, audioTrack: null, onResult: vi.fn(), onDeviceLost }));
    track.readyState = 'ended';
    track.dispatchEvent(new Event('ended'));
    track.dispatchEvent(new Event('ended'));
    await waitFor(() => expect(onDeviceLost).toHaveBeenCalledWith('camera'));
    await waitFor(() => expect(sentTypes(fetch)).toEqual(['CAMERA_DISCONNECTED']));
  });

  it('queues events while offline and reports the outage on reconnect', async () => {
    const fetch = mockFetch({ 'POST /api/assessment/s1/events': () => jsonResponse({ action: 'LOGGED', status: 'IN_PROGRESS' }) });
    renderHook(() => useProctoring({ sessionId: 's1', enabled: true, videoTrack: null, audioTrack: null, onResult: vi.fn(), onDeviceLost: vi.fn() }));
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(sentTypes(fetch)).toEqual(['NETWORK_OFFLINE', 'NETWORK_RESTORED']));
  });

  it('does nothing when disabled', async () => {
    const fetch = mockFetch({});
    renderHook(() => useProctoring({ sessionId: 's1', enabled: false, videoTrack: null, audioTrack: null, onResult: vi.fn(), onDeviceLost: vi.fn() }));
    setHidden(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
  });
});
