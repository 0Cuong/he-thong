import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, KeyRound } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { usePageEnter } from '../lib/gsap';

const SAMPLE_ACCOUNTS = [
  { role: 'Giáo viên', username: 'teacher01', pass: 'Teacher@1234' },
  { role: 'Giám khảo', username: 'grader01', pass: 'Grader@1234' },
  { role: 'Học sinh (Chưa vào nhóm)', username: 'HS048', pass: 'Student@123' },
  { role: 'Học sinh (Nhóm 1)', username: 'HS001', pass: 'Student@123' },
  { role: 'Quản trị hệ thống', username: 'admin', pass: 'Admin@1234' },
];

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  usePageEnter(containerRef, 'login');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await login(username.trim(), password);
      if (user.role === 'STUDENT') {
        navigate('/student', { replace: true });
      } else if (user.role === 'GRADER') {
        navigate('/grader', { replace: true });
      } else {
        navigate('/admin', { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Đăng nhập thất bại.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-6 py-4">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            Lớp 12A17
          </span>
          <span className="text-sm text-slate-500 whitespace-nowrap">
            Chấm điểm Thuyết trình · Thang điểm 10
          </span>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div ref={containerRef} className="w-full max-w-md">
          <div className="rounded-lg border border-slate-200 bg-white p-8">
            <div className="mb-6">
              <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
                Đăng nhập hệ thống
              </h1>
              <p className="mt-1.5 text-sm text-slate-600">
                Sử dụng tài khoản cá nhân được cấp cho Giáo viên, Giám khảo hoặc Học sinh (HS001–HS048).
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div
                  role="alert"
                  className="rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
                >
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="login-username" className="block text-sm font-medium text-slate-700">
                  Tên đăng nhập
                </label>
                <input
                  id="login-username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  required
                  placeholder="Ví dụ: HS048 hoặc teacher01"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
                />
              </div>

              <div>
                <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">
                  Mật khẩu
                </label>
                <input
                  id="login-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="min-h-[44px] w-full rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50"
              >
                {busy ? 'Đang xác thực...' : 'Đăng nhập'}
              </button>
            </form>

            <div className="mt-6 border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={() => setShowAccounts((v) => !v)}
                aria-expanded={showAccounts}
                className="flex w-full items-center justify-between text-left text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Tài khoản mẫu lớp 12A17 (48 học sinh)</span>
                </span>
                {showAccounts ? (
                  <ChevronUp className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                )}
              </button>

              {showAccounts && (
                <div className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200 bg-slate-50">
                  {SAMPLE_ACCOUNTS.map((acc) => (
                    <div
                      key={acc.username}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                    >
                      <div>
                        <div className="font-medium text-slate-800">{acc.role}</div>
                        <div className="font-mono text-slate-500">
                          {acc.username} / {acc.pass}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setUsername(acc.username);
                          setPassword(acc.pass);
                          setError(null);
                        }}
                        className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                      >
                        Điền nhanh
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white py-4">
        <div className="mx-auto max-w-6xl px-6 text-xs text-slate-500">
          Lớp 12A17 · Hệ thống chấm điểm thuyết trình trực tiếp (Thang điểm 10)
        </div>
      </footer>
    </div>
  );
}
