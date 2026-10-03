import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { LockKeyhole } from 'lucide-react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { adminLoginSchema } from '@test-orbit/shared';
import type { z } from 'zod';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/Form';
import { Alert, LoadingState } from '@/components/ui/States';
import { adminKeys, useAdminMe } from '@/hooks/useAdmin';
import { api, errorMessage } from '@/services/api';
import type { AdminUser } from '@/types/api';

type Values = z.input<typeof adminLoginSchema>;

export function AdminLoginPage() {
  const me = useAdminMe();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(adminLoginSchema) });

  if (me.isLoading) return <LoadingState />;
  if (me.data) return <Navigate to="/admin/dashboard" replace />;

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      const { admin } = await api.post<{ admin: AdminUser }>('/auth/admin/login', values);
      qc.setQueryData(adminKeys.me, admin);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith('/admin') ? from : '/admin/dashboard', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-navy-950 px-4 py-10">
      <div className="mb-8">
        <Logo inverted />
      </div>
      <Card className="w-full max-w-sm">
        <CardBody className="p-6">
          <div className="mb-5 flex items-center gap-2">
            <LockKeyhole className="size-5 text-brand-600" />
            <h1 className="text-lg font-semibold text-ink">Administrator sign in</h1>
          </div>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Email" error={errors.email?.message} required>
              {({ id, describedBy, invalid }) => <Input id={id} type="email" autoComplete="username" aria-describedby={describedBy} invalid={invalid} {...register('email')} />}
            </Field>
            <Field label="Password" error={errors.password?.message} required>
              {({ id, describedBy, invalid }) => <Input id={id} type="password" autoComplete="current-password" aria-describedby={describedBy} invalid={invalid} {...register('password')} />}
            </Field>
            <Button type="submit" className="w-full" loading={isSubmitting}>
              Sign in
            </Button>
          </form>
        </CardBody>
      </Card>
      <Link to="/" className="mt-6 text-sm text-white/60 hover:text-white">
        ← Back to the student portal
      </Link>
    </div>
  );
}
