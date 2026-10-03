import { describe, expect, it, vi } from 'vitest';
import { blockedRequests, installNetworkGuard, isSameOrigin } from './networkGuard';

describe('network privacy guard', () => {
  it('classifies URLs by origin', () => {
    expect(isSameOrigin('/api/assessment/s1/events')).toBe(true);
    expect(isSameOrigin(`${window.location.origin}/models/x.tflite`)).toBe(true);
    expect(isSameOrigin('https://odml.pa.googleapis.com/v1/log')).toBe(false);
  });

  it('blocks third-party fetches (e.g. detector telemetry) and lets same-origin calls through', async () => {
    const underlying = vi.fn(async () => new Response('ok'));
    window.fetch = underlying as unknown as typeof fetch;
    installNetworkGuard();
    await expect(fetch('https://odml.pa.googleapis.com/v1/log', { method: 'POST', body: 'x' })).rejects.toThrow(/privacy guard/);
    expect(underlying).not.toHaveBeenCalled();
    expect(blockedRequests).toContain('https://odml.pa.googleapis.com');
    await fetch('/api/health');
    expect(underlying).toHaveBeenCalledTimes(1);
  });
});
