import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { changePasswordSchema } from '@test-orbit/shared';
import type { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/Form';
import { Alert } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { adminKeys } from '@/hooks/useAdmin';
import { ApiError, api } from '@/services/api';

type Values = z.input<typeof changePasswordSchema>;

export function ChangePasswordCard({ forced, onLogout }: { forced?: boolean; onLogout?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(changePasswordSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post('/auth/admin/change-password', values);
      toast.success('Password changed', forced ? 'You can now use the admin portal.' : 'Other sessions were signed out.');
      reset();
      await qc.invalidateQueries({ queryKey: adminKeys.me });
    } catch (e) {
      if (e instanceof ApiError) {
        for (const [f, m] of Object.entries(e.fieldErrors)) setFieldError(f as keyof Values, { message: m });
        setError(e.message);
      } else setError('Could not change password');
    }
  });

  return (
    <Card className={forced ? 'w-full max-w-md' : undefined}>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <KeyRound className="size-4 text-brand-600" /> {forced ? 'Set a new password' : 'Change password'}
          </span>
        }
        description={forced ? 'The initial administrator password must be changed before you can continue.' : 'Changing your password signs out your other sessions.'}
      />
      <CardBody>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Current password" error={errors.currentPassword?.message} required>
            {({ id, describedBy, invalid }) => <Input id={id} type="password" autoComplete="current-password" aria-describedby={describedBy} invalid={invalid} {...register('currentPassword')} />}
          </Field>
          <Field label="New password" error={errors.newPassword?.message} hint="At least 12 characters with upper-case, lower-case and a number." required>
            {({ id, describedBy, invalid }) => <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} invalid={invalid} {...register('newPassword')} />}
          </Field>
          <Field label="Confirm new password" error={errors.confirmPassword?.message} required>
            {({ id, describedBy, invalid }) => <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} invalid={invalid} {...register('confirmPassword')} />}
          </Field>
          <div className="flex items-center justify-between gap-3 pt-1">
            {onLogout ? (
              <Button variant="ghost" onClick={onLogout}>
                Sign out
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" loading={isSubmitting}>
              Update password
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
