import { createRef } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@test-orbit/shared';
import { useFaceMonitor } from './useFaceMonitor';
import { useSpeechMonitor } from './useSpeechMonitor';

const monitoring = { ...DEFAULT_SETTINGS.proctoring.monitoring, faceDetectionIntervalMs: 1000, faceAbsenceSeconds: 3, multipleFacesSeconds: 2 };

function fakeVideo() {
  const v = document.createElement('video');
  Object.defineProperty(v, 'readyState', { value: 4 });
  Object.defineProperty(v, 'videoWidth', { value: 640 });
  return v;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useFaceMonitor (mocked detector)', () => {
  it('turns detector output into one event per condition and cleans up on unmount', async () => {
    let faces = 1;
    const detector = {
      detectForVideo: vi.fn(() => ({ detections: Array.from({ length: faces }, () => ({ categories: [{ score: 0.93 }] })) })),
      close: vi.fn(),
    };
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL');
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');
    const onEvent = vi.fn();
    const ref = createRef<HTMLVideoElement>() as { current: HTMLVideoElement | null };
    ref.current = fakeVideo();
    const stream = {} as MediaStream;
    const { result, unmount } = renderHook(() =>
      useFaceMonitor({ videoRef: ref, streamKey: stream, settings: monitoring, enabled: true, onEvent, onUnavailable: vi.fn(), factory: async () => detector }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe('active');
    faces = 2;
    await act(async () => void vi.advanceTimersByTime(6000));
    faces = 0;
    await act(async () => void vi.advanceTimersByTime(10000));
    expect(onEvent.mock.calls.map((c) => c[0].type)).toEqual(['MULTIPLE_FACES_DETECTED', 'FACE_NOT_VISIBLE']);
    expect(onEvent.mock.calls[0]![0].details).toMatchObject({ faceCount: 2, confidence: 0.93 });
    // Frames are only read in memory — never converted to images.
    expect(toDataURL).not.toHaveBeenCalled();
    expect(toBlob).not.toHaveBeenCalled();

    const calls = detector.detectForVideo.mock.calls.length;
    unmount();
    expect(detector.close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(detector.detectForVideo.mock.calls.length).toBe(calls);
  });

  it('reports "monitoring unavailable" once when the model cannot load, and keeps the hook usable', async () => {
    vi.useRealTimers();
    const onUnavailable = vi.fn();
    const ref = { current: fakeVideo() };
    const { result } = renderHook(() =>
      useFaceMonitor({
        videoRef: ref,
        streamKey: {} as MediaStream,
        settings: monitoring,
        enabled: true,
        onEvent: vi.fn(),
        onUnavailable,
        factory: () => Promise.reject(new Error('model fetch failed')),
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable.mock.calls[0]![0]).toMatch(/model fetch failed/);
  });

  it('does nothing when face detection is disabled in settings', () => {
    const factory = vi.fn();
    const { result } = renderHook(() =>
      useFaceMonitor({ videoRef: { current: fakeVideo() }, streamKey: {} as MediaStream, settings: { ...monitoring, faceDetectionEnabled: false }, enabled: true, onEvent: vi.fn(), onUnavailable: vi.fn(), factory }),
    );
    expect(result.current.status).toBe('disabled');
    expect(factory).not.toHaveBeenCalled();
  });
});

class FakeAnalyser {
  fftSize = 1024;
  smoothingTimeConstant = 0;
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  static level = 0;
  getFloatTimeDomainData(arr: Float32Array) {
    for (let i = 0; i < arr.length; i++) arr[i] = FakeAnalyser.level * Math.sin(i / 2);
  }
  getFloatFrequencyData(arr: Float32Array) {
    const binHz = 48000 / 2 / arr.length;
    for (let i = 0; i < arr.length; i++) arr[i] = i * binHz >= 300 && i * binHz <= 3400 ? -30 : -120;
  }
}
const ctxInstances: FakeAudioContext[] = [];
class FakeAudioContext {
  state = 'running';
  sampleRate = 48000;
  source = { connect: vi.fn(), disconnect: vi.fn() };
  close = vi.fn(async () => undefined);
  resume = vi.fn(async () => undefined);
  constructor() {
    ctxInstances.push(this);
  }
  createMediaStreamSource() {
    return this.source;
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
}

describe('useSpeechMonitor (mocked Web Audio)', () => {
  it('warns about sustained speech once per cooldown, never records, and closes audio on unmount', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaStream', class {
      constructor(public tracks: unknown[]) {}
    });
    const recorder = vi.fn();
    vi.stubGlobal('MediaRecorder', recorder);
    const onEvent = vi.fn();
    const track = { readyState: 'live' } as MediaStreamTrack;
    const { result, unmount } = renderHook(() => useSpeechMonitor({ audioTrack: track, settings: monitoring, enabled: true, onEvent, onUnavailable: vi.fn() }));
    expect(result.current.status).toBe('active');

    FakeAnalyser.level = 0.0003; // quiet room
    act(() => void vi.advanceTimersByTime(3000));
    FakeAnalyser.level = 0.05; // talking
    act(() => void vi.advanceTimersByTime(20000));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]![0]).toMatchObject({ type: 'SPEECH_DETECTED' });
    expect(Object.keys(onEvent.mock.calls[0]![0].details).sort()).toEqual(['durationMs', 'levelDb', 'voicedRatio']);
    expect(recorder).not.toHaveBeenCalled();

    const ctx = ctxInstances.at(-1)!;
    unmount();
    expect(ctx.source.disconnect).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
  });

  it('reports microphone monitoring unavailable when Web Audio is missing', () => {
    vi.stubGlobal('AudioContext', undefined);
    const onUnavailable = vi.fn();
    const { result } = renderHook(() =>
      useSpeechMonitor({ audioTrack: { readyState: 'live' } as MediaStreamTrack, settings: monitoring, enabled: true, onEvent: vi.fn(), onUnavailable }),
    );
    expect(result.current.status).toBe('unavailable');
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
