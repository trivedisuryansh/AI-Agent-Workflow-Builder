'use client';

import { useState } from 'react';

import { useAuth } from '../app/providers';

/**
 * Seeded demo accounts, shown as one-click fills.
 *
 * Gated behind NEXT_PUBLIC_SHOW_DEMO_LOGINS so it is an explicit choice rather
 * than something that leaks into a real deployment by default. These are
 * throwaway accounts created by `npm run seed` whose whole purpose is to let a
 * reviewer sign in as each role — including the Org B user, to confirm that
 * Org A's data is genuinely unreachable rather than merely hidden.
 *
 * It also removes a real papercut: the password contains a digit zero
 * ("Passw0rd") and the addresses end in .test, both of which are easy to
 * mistype into an "invalid email or password" dead end.
 */
const DEMO_ACCOUNTS = [
  { email: 'owner.a@example.test', label: 'Org A — Owner', hint: 'full access incl. db_write, notify, webhooks' },
  { email: 'editor.a@example.test', label: 'Org A — Editor', hint: 'can build and run, but not restricted steps' },
  { email: 'viewer.a@example.test', label: 'Org A — Viewer', hint: 'read-only; cannot trigger or approve' },
  { email: 'owner.b@example.test', label: 'Org B — Owner', hint: 'no membership in Org A at all' },
];

const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? 'Passw0rd!seed';
const SHOW_DEMO_LOGINS = process.env.NEXT_PUBLIC_SHOW_DEMO_LOGINS === 'true';

export function LoginForm() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
      } else {
        const message = await signUp(email.trim(), password, displayName.trim() || email.trim());
        if (message) setNotice(message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '80px auto', padding: 16 }}>
      <h1 style={{ marginBottom: 4 }}>AI Agent Workflow Builder</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Sign in with an Nhost account. Your organizations and role are resolved from the database
        after authentication.
      </p>

      <form className="panel stack" onSubmit={submit} style={{ marginTop: 20 }}>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className={mode === 'signin' ? 'primary' : ''}
            onClick={() => setMode('signin')}
          >
            Sign in
          </button>
          <button
            type="button"
            className={mode === 'signup' ? 'primary' : ''}
            onClick={() => setMode('signup')}
          >
            Create account
          </button>
        </div>

        {mode === 'signup' && (
          <div>
            <label htmlFor="displayName">Display name</label>
            <input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
            />
          </div>
        )}

        <div>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>

        <div>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />
        </div>

        {error && <div className="error-box">{error}</div>}
        {notice && <div className="ok-box">{notice}</div>}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      {SHOW_DEMO_LOGINS && mode === 'signin' && (
        <div className="panel stack" style={{ marginTop: 16, gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Seeded demo accounts</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            Click to fill, then press Sign in. Sign in as the Org B owner to confirm Org A&rsquo;s
            data is unreachable, not merely hidden.
          </span>
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              style={{ textAlign: 'left' }}
              onClick={() => {
                setEmail(account.email);
                setPassword(DEMO_PASSWORD);
                setError(null);
                setNotice(null);
              }}
            >
              <div>
                <strong>{account.label}</strong>{' '}
                <span className="mono muted">{account.email}</span>
              </div>
              <div className="muted" style={{ fontSize: 11 }}>
                {account.hint}
              </div>
            </button>
          ))}
          <span className="muted mono" style={{ fontSize: 11 }}>
            password: {DEMO_PASSWORD} (note the digit zero)
          </span>
        </div>
      )}
    </div>
  );
}
