import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

export function ChangePasswordModal({
  open,
  forced = false,
  onClose,
}: {
  open: boolean;
  forced?: boolean;
  onClose: () => void;
}) {
  const { changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 6) {
      setError('Mật khẩu mới phải có ít nhất 6 ký tự.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Mật khẩu xác nhận không khớp.');
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể đổi mật khẩu.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwd-modal-title"
    >
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-xl">
        <div className="flex items-center gap-2 text-slate-900">
          <Lock className="h-5 w-5 text-indigo-600" aria-hidden="true" />
          <h2 id="pwd-modal-title" className="text-lg font-semibold">
            {forced ? 'Đổi mật khẩu lần đầu đăng nhập' : 'Đổi mật khẩu tài khoản'}
          </h2>
        </div>
        <p className="mt-1.5 text-sm text-slate-600">
          {forced
            ? 'Tài khoản của bạn đang dùng mật khẩu tạm thời. Vui lòng đặt mật khẩu mới để bảo mật.'
            : 'Nhập mật khẩu hiện tại và mật khẩu mới tối thiểu 6 ký tự.'}
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="cur-pwd" className="block text-sm font-medium text-slate-700">
              Mật khẩu hiện tại
            </label>
            <input
              id="cur-pwd"
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
            />
          </div>

          <div>
            <label htmlFor="new-pwd" className="block text-sm font-medium text-slate-700">
              Mật khẩu mới
            </label>
            <input
              id="new-pwd"
              type="password"
              required
              minLength={6}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
            />
          </div>

          <div>
            <label htmlFor="cfm-pwd" className="block text-sm font-medium text-slate-700">
              Xác nhận mật khẩu mới
            </label>
            <input
              id="cfm-pwd"
              type="password"
              required
              minLength={6}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            {!forced && (
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="min-h-[40px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
            )}
            <button
              type="submit"
              disabled={busy}
              className="min-h-[40px] rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? 'Đang cập nhật...' : 'Lưu mật khẩu mới'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
