import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Camera, CheckCircle2, Mic, RefreshCcw, ShieldCheck, VideoOff, XCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Form';
import { Alert } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { StudentGate } from '@/components/StudentGate';
import { useAudioLevel } from '@/hooks/useAudioLevel';
import { studentKeys } from '@/hooks/useStudent';
import { StepIndicator } from '@/layouts/PublicLayout';
import { api, errorMessage } from '@/services/api';
import { DEVICE_MESSAGES, acquireCamera, acquireMicrophone, captureFrame, currentStreams, mediaSupport, safePlay, statusFromError, type DeviceStatus } from '@/services/media';
import type { StudentProfile } from '@/types/api';
import { cn } from '@/utils/format';

const MIC_THRESHOLD = 0.12;

export function DeviceCheckPage() {
  return <StudentGate allow={['device-check', 'instructions']}>{(profile) => <DeviceCheck profile={profile} />}</StudentGate>;
}

function DeviceCheck({ profile }: { profile: StudentProfile }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const support = mediaSupport();
  const videoRef = useRef<HTMLVideoElement>(null);

  const [camera, setCamera] = useState<DeviceStatus>('idle');
  const [mic, setMic] = useState<DeviceStatus>('idle');
  const [videoStream, setVideoStream] = useState<MediaStream | null>(() => currentStreams().video);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(() => currentStreams().audio);
  const [micHeard, setMicHeard] = useState(false);
  const level = useAudioLevel(audioStream);

  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [photoConfirmed, setPhotoConfirmed] = useState(profile.deviceCheck.photoCaptured);
  const [consent, setConsent] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const requestDevices = useCallback(async () => {
    setCamera('requesting');
    setMic('requesting');
    try {
      const v = await acquireCamera();
      setVideoStream(v);
      setCamera('ok');
    } catch (e) {
      setCamera(statusFromError(e));
    }
    try {
      const a = await acquireMicrophone();
      setAudioStream(a);
      setMic('ok');
    } catch (e) {
      setMic(statusFromError(e));
    }
  }, []);

  // Re-use streams granted earlier in this tab.
  useEffect(() => {
    if (videoStream) setCamera('ok');
    if (audioStream) setMic('ok');
  }, [videoStream, audioStream]);

  useEffect(() => {
    if (videoRef.current && videoStream) {
      videoRef.current.srcObject = videoStream;
      safePlay(videoRef.current);
    }
  }, [videoStream, photo]);

  // Detect track loss (e.g. permission revoked in browser settings).
  useEffect(() => {
    const tracks = [...(videoStream?.getTracks() ?? []), ...(audioStream?.getTracks() ?? [])];
    const onEnded = () => {
      if (videoStream?.getVideoTracks().some((t) => t.readyState === 'ended')) setCamera('error');
      if (audioStream?.getAudioTracks().some((t) => t.readyState === 'ended')) setMic('error');
    };
    tracks.forEach((t) => t.addEventListener('ended', onEnded));
    return () => tracks.forEach((t) => t.removeEventListener('ended', onEnded));
  }, [videoStream, audioStream]);

  useEffect(() => {
    if (level > MIC_THRESHOLD) setMicHeard(true);
  }, [level]);

  useEffect(
    () => () => {
      if (photo) URL.revokeObjectURL(photo.url);
    },
    [photo],
  );

  const capture = async () => {
    if (!videoRef.current) return;
    try {
      const blob = await captureFrame(videoRef.current);
      setPhoto({ blob, url: URL.createObjectURL(blob) });
      setPhotoConfirmed(false);
      setConsent(false);
    } catch (e) {
      toast.error('Could not capture photo', errorMessage(e));
    }
  };

  const confirmPhoto = async () => {
    if (!photo) return;
    setUploading(true);
    try {
      const res = await api.upload<{ stored: boolean }>('/identity-photo', photo.blob, 'image/jpeg');
      setPhotoConfirmed(true);
      URL.revokeObjectURL(photo.url);
      setPhoto(null);
      toast.success(res.stored ? 'Identity photo saved' : 'Photo step complete', res.stored ? undefined : 'Photo storage is disabled — nothing was stored.');
    } catch (e) {
      toast.error('Photo upload failed', errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const photoNeeded = profile.deviceCheck.photoRequired;
  const ready = camera === 'ok' && mic === 'ok' && micHeard && (!photoNeeded || photoConfirmed);

  const finish = async () => {
    setFinishing(true);
    try {
      const updated = await api.post<StudentProfile>('/device-check/complete', { cameraOk: true, microphoneOk: true, userAgent: navigator.userAgent.slice(0, 500) });
      qc.setQueryData(studentKeys.me, updated);
      navigate('/instructions');
    } catch (e) {
      toast.error('Could not complete the device check', errorMessage(e));
    } finally {
      setFinishing(false);
    }
  };

  if (!support.ok) {
    return (
      <div>
        <StepIndicator current={2} />
        <Alert tone="danger" title="This browser cannot run the assessment" icon={<VideoOff className="size-5" />}>
          {support.reason}
        </Alert>
      </div>
    );
  }

  return (
    <div>
      <StepIndicator current={2} />
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Camera & microphone check</h1>
        <p className="mt-1 text-sm text-ink-muted">Camera and microphone access is required for the assessment and must stay enabled until you submit.</p>
      </div>

      <Alert tone="info" icon={<ShieldCheck className="size-5" />} title="Your privacy">
        Video and audio stay on this computer and are never recorded, stored or uploaded. They are used for the live preview, the microphone test and — during the assessment —
        automatic on-device checks (face visible, more than one person, sustained speech) that create event records for staff review. These checks can be wrong. The only image sent is the
        single photo you explicitly confirm below.
      </Alert>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader
            title="Live preview"
            actions={
              camera !== 'ok' || mic !== 'ok' ? (
                <Button onClick={requestDevices} loading={camera === 'requesting'} icon={camera === 'idle' ? <Camera className="size-4" /> : <RefreshCcw className="size-4" />}>
                  {camera === 'idle' ? 'Allow camera & microphone' : 'Retry'}
                </Button>
              ) : null
            }
          />
          <CardBody>
            <div className="relative aspect-video overflow-hidden rounded-xl bg-navy-950">
              {photo ? (
                <img src={photo.url} alt="Captured identity photo preview" className="size-full object-contain" />
              ) : videoStream ? (
                <video ref={videoRef} autoPlay playsInline muted className="size-full -scale-x-100 object-cover" aria-label="Your camera preview" />
              ) : (
                <div className="flex size-full flex-col items-center justify-center gap-2 text-white/70">
                  <Camera className="size-8" />
                  <p className="text-sm">Camera preview will appear here</p>
                </div>
              )}
              {photo && <span className="absolute left-3 top-3 rounded-full bg-white/90 px-2 py-0.5 text-xs font-medium text-ink">Captured photo</span>}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              {!photoConfirmed || photo ? (
                photo ? (
                  <>
                    <Button variant="secondary" onClick={() => setPhoto(null)} icon={<RefreshCcw className="size-4" />}>
                      Retake
                    </Button>
                    <Checkbox
                      className="flex-1"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                      label="My face is clearly visible, and I consent to this photo being stored for identity verification."
                    />
                    <Button onClick={confirmPhoto} disabled={!consent} loading={uploading}>
                      Confirm photo
                    </Button>
                  </>
                ) : (
                  <Button onClick={capture} disabled={camera !== 'ok'} icon={<Camera className="size-4" />}>
                    Capture photo
                  </Button>
                )
              ) : (
                <>
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
                    <CheckCircle2 className="size-4" /> Identity photo confirmed
                  </span>
                  <Button variant="ghost" size="sm" onClick={capture} disabled={camera !== 'ok'}>
                    Recapture
                  </Button>
                </>
              )}
            </div>
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Checks" />
            <CardBody className="space-y-4">
              <CheckRow icon={<Camera className="size-4" />} label="Camera" status={camera} />
              <CheckRow icon={<Mic className="size-4" />} label="Microphone" status={mic} />
              <div>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="font-medium text-ink">Microphone level</span>
                  <span className={cn('text-xs', micHeard ? 'font-medium text-emerald-700' : 'text-ink-subtle')}>{micHeard ? 'Sound detected ✓' : 'Say a few words…'}</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-line" role="meter" aria-label="Microphone input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
                  <div className={cn('h-full rounded-full transition-[width] duration-75', micHeard ? 'bg-emerald-500' : 'bg-brand-600')} style={{ width: `${Math.round(level * 100)}%` }} />
                </div>
              </div>
              {photoNeeded && (
                <CheckRow icon={<CheckCircle2 className="size-4" />} label="Identity photo" status={photoConfirmed ? 'ok' : 'idle'} idleText="Capture and confirm a photo" />
              )}
            </CardBody>
          </Card>
          <Button size="lg" className="w-full" disabled={!ready} loading={finishing} onClick={finish}>
            Continue to instructions
          </Button>
          {!ready && <p className="text-center text-xs text-ink-subtle">Complete every check above to continue.</p>}
        </div>
      </div>
    </div>
  );
}

function CheckRow({ icon, label, status, idleText }: { icon: React.ReactNode; label: string; status: DeviceStatus; idleText?: string }) {
  const ok = status === 'ok';
  const bad = status === 'denied' || status === 'missing' || status === 'busy' || status === 'error';
  return (
    <div className="flex items-start gap-3">
      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', ok ? 'bg-emerald-50 text-emerald-700' : bad ? 'bg-red-50 text-red-700' : 'bg-canvas text-ink-subtle')}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
          {label}
          {ok && <CheckCircle2 className="size-4 text-emerald-600" aria-label="ready" />}
          {bad && <XCircle className="size-4 text-red-600" aria-label="problem" />}
        </p>
        <p className={cn('text-xs', bad ? 'text-red-700' : 'text-ink-subtle')} role={bad ? 'alert' : undefined}>
          {status === 'idle' && idleText ? idleText : DEVICE_MESSAGES[status]}
        </p>
      </div>
    </div>
  );
}
