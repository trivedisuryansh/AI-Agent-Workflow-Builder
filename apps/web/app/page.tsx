'use client';

import { useAuth } from './providers';
import { Dashboard } from '../components/Dashboard';
import { LoginForm } from '../components/LoginForm';

export default function Page() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ padding: 40 }} className="muted">
        Restoring session…
      </div>
    );
  }

  return session ? <Dashboard /> : <LoginForm />;
}
