import React, { useCallback, useEffect, useState } from 'react';
import {
  Download,
  KeyRound,
  Plus,
  Search,
  Upload,
  UserCheck,
  UserX,
  Users,
} from 'lucide-react';
import { apiFetch, downloadAuthenticatedFile, formatViDateTime } from '../../lib/api';
import { ConfirmModal } from '../ConfirmModal';

interface UserItem {
  id: string;
  username: string;
  role: string;
  is_active: number;
  must_change_password: number;
  last_login_at: string | null;
  login_count: number;
  full_name: string | null;
  student_code: string | null;
  email: string | null;
}

interface ClassroomItem {
  id: string;
  name: string;
  code: string;
}

export function StudentsManager({ classrooms }: { classrooms: ClassroomItem[] }) {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all');
  const [classroomFilter, setClassroomFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Bulk generate 48 students
  const [showBulk, setShowBulk] = useState(false);
  const [bulkPrefix, setBulkPrefix] = useState('HS');
  const [bulkCount, setBulkCount] = useState(48);
  const [bulkStart, setBulkStart] = useState(1);
  const [bulkPassword, setBulkPassword] = useState('Student@123');
  const [bulkClassroomId, setBulkClassroomId] = useState(classrooms[0]?.id ?? '');

  // Single create / edit
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('Student@123');
  const [newClassroomId, setNewClassroomId] = useState(classrooms[0]?.id ?? '');

  // Edit user modal
  const [editUser, setEditUser] = useState<UserItem | null>(null);
  const [editUsername, setEditUsername] = useState('');
  const [editFullName, setEditFullName] = useState('');
  const [editEmail, setEditEmail] = useState('');

  // Reset password modal
  const [resetTarget, setResetTarget] = useState<UserItem | null>(null);
  const [resetPwd, setResetPwd] = useState('Student@123');

  const [busy, setBusy] = useState(false);

  const loadStudents = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        role: 'STUDENT',
        limit: '200',
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
        ...(classroomFilter ? { classroomId: classroomFilter } : {}),
      });
      const data = await apiFetch<{ users: UserItem[]; total: number }>(`/api/users?${qs}`);
      setUsers(data.users);
      setTotal(data.total);
    } catch (err) {
      setNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'Không thể tải danh sách học sinh.',
      });
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, classroomFilter]);

  useEffect(() => {
    const t = setTimeout(() => void loadStudents(), 200);
    return () => clearTimeout(t);
  }, [loadStudents]);

  useEffect(() => {
    if (!bulkClassroomId && classrooms[0]) setBulkClassroomId(classrooms[0].id);
    if (!newClassroomId && classrooms[0]) setNewClassroomId(classrooms[0].id);
  }, [classrooms, bulkClassroomId, newClassroomId]);

  const handleBulkGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const res = await apiFetch<{ createdCount: number; skippedCount: number }>(
        '/api/users/bulk-generate-students',
        {
          method: 'POST',
          body: JSON.stringify({
            prefix: bulkPrefix,
            count: bulkCount,
            startNumber: bulkStart,
            defaultPassword: bulkPassword,
            classroomId: bulkClassroomId,
          }),
        }
      );
      setShowBulk(false);
      setNotice({
        type: 'success',
        text: `Đã tạo ${res.createdCount} tài khoản học sinh mới (bỏ qua ${res.skippedCount} tài khoản đã tồn tại).`,
      });
      await loadStudents();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Tạo hàng loạt thất bại.' });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateSingle = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUsername,
          fullName: newFullName,
          email: newEmail,
          password: newPassword,
          role: 'STUDENT',
          classroomId: newClassroomId,
        }),
      });
      setShowCreate(false);
      setNewUsername('');
      setNewFullName('');
      setNewEmail('');
      setNotice({ type: 'success', text: 'Đã tạo tài khoản học sinh mới.' });
      await loadStudents();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Không thể tạo tài khoản.' });
    } finally {
      setBusy(false);
    }
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setNotice(null);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      const res = await apiFetch<{ imported: number; updated: number }>('/api/users/import-students', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          base64,
          classroomId: bulkClassroomId || classrooms[0]?.id || '',
        }),
      });
      setNotice({
        type: 'success',
        text: `Nhập danh sách thành công: ${res.imported} tài khoản mới, ${res.updated} tài khoản cập nhật.`,
      });
      await loadStudents();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Nhập tệp thất bại.' });
    } finally {
      e.target.value = '';
      setBusy(false);
    }
  };

  const handleToggleActive = async (u: UserItem) => {
    setBusy(true);
    try {
      await apiFetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: u.is_active !== 1 }),
      });
      await loadStudents();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Không thể đổi trạng thái.' });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editUser) return;
    setBusy(true);
    try {
      await apiFetch(`/api/users/${editUser.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          username: editUsername,
          fullName: editFullName,
          email: editEmail,
        }),
      });
      setEditUser(null);
      setNotice({ type: 'success', text: 'Đã cập nhật thông tin học sinh.' });
      await loadStudents();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Cập nhật thất bại.' });
    } finally {
      setBusy(false);
    }
  };

  const handleResetPassword = async () => {
    if (!resetTarget) return;
    setBusy(true);
    try {
      await apiFetch(`/api/users/${resetTarget.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ newPassword: resetPwd, mustChangePassword: true }),
      });
      setResetTarget(null);
      setNotice({
        type: 'success',
        text: `Đã đặt lại mật khẩu tạm thời cho ${resetTarget.username}. Học sinh sẽ cần đổi mật khẩu khi đăng nhập.`,
      });
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Đặt lại mật khẩu thất bại.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-xl font-bold text-slate-900">
            Quản lý Tài khoản Học sinh ({total})
          </h2>
          <p className="text-sm text-slate-600">
            Tạo tự động 48 tài khoản HS001–HS048, nhập từ CSV/Excel, đặt lại mật khẩu và quản lý trạng thái.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowBulk((v) => !v)}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 whitespace-nowrap"
          >
            <Users className="h-4 w-4" aria-hidden="true" />
            <span>Tạo nhanh 48 HS</span>
          </button>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>Thêm 1 học sinh</span>
          </button>
          <label className="inline-flex min-h-[40px] cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap">
            <Upload className="h-4 w-4" aria-hidden="true" />
            <span>Nhập CSV / XLSX</span>
            <input
              type="file"
              accept=".csv,.xlsx"
              onChange={(e) => void handleFileImport(e)}
              className="sr-only"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              void downloadAuthenticatedFile('/api/users/export-students', 'danh-sach-hoc-sinh.csv').catch(
                (err) =>
                  setNotice({
                    type: 'error',
                    text: err instanceof Error ? err.message : 'Xuất CSV thất bại.',
                  })
              )
            }
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            <span>Xuất CSV</span>
          </button>
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className={`rounded-md border px-4 py-3 text-sm ${
            notice.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* Bulk Generate Form */}
      {showBulk && (
        <form
          onSubmit={handleBulkGenerate}
          className="rounded-lg border border-indigo-200 bg-white p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">
            Tạo hàng loạt tài khoản học sinh (VD: HS001 – HS048)
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <label className="block text-xs font-medium text-slate-600">Tiền tố</label>
              <input
                type="text"
                value={bulkPrefix}
                onChange={(e) => setBulkPrefix(e.target.value)}
                required
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono uppercase"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Số lượng</label>
              <input
                type="number"
                min={1}
                max={200}
                value={bulkCount}
                onChange={(e) => setBulkCount(Number(e.target.value))}
                required
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Bắt đầu từ số</label>
              <input
                type="number"
                min={1}
                value={bulkStart}
                onChange={(e) => setBulkStart(Number(e.target.value))}
                required
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Mật khẩu tạm</label>
              <input
                type="text"
                minLength={6}
                value={bulkPassword}
                onChange={(e) => setBulkPassword(e.target.value)}
                required
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Gán vào lớp</label>
              <select
                value={bulkClassroomId}
                onChange={(e) => setBulkClassroomId(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Không gán lớp</option>
                {classrooms.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowBulk(false)}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
            >
              Đóng
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? 'Đang tạo...' : 'Xác nhận tạo hàng loạt'}
            </button>
          </div>
        </form>
      )}

      {/* Single Create Form */}
      {showCreate && (
        <form
          onSubmit={handleCreateSingle}
          className="rounded-lg border border-slate-200 bg-white p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">Thêm tài khoản học sinh thủ công</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <label className="block text-xs font-medium text-slate-600">Tên đăng nhập</label>
              <input
                type="text"
                required
                placeholder="HS049"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Họ và tên</label>
              <input
                type="text"
                required
                placeholder="Nguyễn Văn A"
                value={newFullName}
                onChange={(e) => setNewFullName(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Email</label>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Mật khẩu tạm</label>
              <input
                type="text"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Lớp học</label>
              <select
                value={newClassroomId}
                onChange={(e) => setNewClassroomId(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Không gán lớp</option>
                {classrooms.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
            >
              Đóng
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
            >
              Tạo tài khoản
            </button>
          </div>
        </form>
      )}

      {/* Search & Filters */}
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="Tìm kiếm học sinh"
            placeholder="Tìm theo mã HS, tên đăng nhập hoặc họ tên..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-slate-300 pl-9 pr-3 py-2 text-sm focus:border-indigo-600 focus:outline-none"
          />
        </div>
        <select
          aria-label="Lọc theo lớp"
          value={classroomFilter}
          onChange={(e) => setClassroomFilter(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">Tất cả lớp học</option>
          {classrooms.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1">
          {(['all', 'active', 'disabled'] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`rounded px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                statusFilter === st ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              {st === 'all' ? 'Tất cả' : st === 'active' ? 'Đang hoạt động' : 'Đã khóa'}
            </button>
          ))}
        </div>
      </div>

      {/* Students Table */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
            <tr>
              <th className="px-4 py-3">Tài khoản</th>
              <th className="px-4 py-3">Họ và tên</th>
              <th className="px-4 py-3">Trạng thái</th>
              <th className="px-4 py-3">Hoạt động đăng nhập</th>
              <th className="px-4 py-3 text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  Đang tải danh sách...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  Không tìm thấy học sinh phù hợp.
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50/70">
                  <td className="px-4 py-2.5 font-mono font-semibold text-slate-900 whitespace-nowrap">
                    {u.username}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-900">{u.full_name || '—'}</div>
                    {u.email && <div className="text-xs text-slate-500">{u.email}</div>}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {u.is_active === 1 ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                        <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Hoạt động</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
                        <UserX className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Đã khóa</span>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600 tabular-nums whitespace-nowrap">
                    {u.login_count} lượt · {formatViDateTime(u.last_login_at)}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditUser(u);
                        setEditUsername(u.username);
                        setEditFullName(u.full_name || '');
                        setEditEmail(u.email || '');
                      }}
                      className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Sửa
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setResetTarget(u);
                        setResetPwd('Student@123');
                      }}
                      className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <KeyRound className="h-3 w-3" aria-hidden="true" />
                      <span>Đặt lại MK</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleToggleActive(u)}
                      className={`rounded border px-2.5 py-1 text-xs font-medium ${
                        u.is_active === 1
                          ? 'border-red-200 text-red-700 hover:bg-red-50'
                          : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                      }`}
                    >
                      {u.is_active === 1 ? 'Khóa' : 'Mở khóa'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Edit Student Modal */}
      <ConfirmModal
        open={Boolean(editUser)}
        title={`Cập nhật tài khoản ${editUser?.username ?? ''}`}
        confirmLabel="Lưu thay đổi"
        busy={busy}
        onConfirm={() => void handleSaveEdit()}
        onCancel={() => setEditUser(null)}
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-700">Tên đăng nhập</label>
            <input
              type="text"
              value={editUsername}
              onChange={(e) => setEditUsername(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">Họ và tên</label>
            <input
              type="text"
              value={editFullName}
              onChange={(e) => setEditFullName(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">Email</label>
            <input
              type="email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
      </ConfirmModal>

      {/* Reset Password Modal */}
      <ConfirmModal
        open={Boolean(resetTarget)}
        title={`Đặt lại mật khẩu cho ${resetTarget?.username ?? ''}`}
        description="Mật khẩu mới sẽ được mã hóa an toàn. Mật khẩu cũ không bao giờ được hiển thị hoặc khôi phục."
        confirmLabel="Đặt lại mật khẩu"
        busy={busy}
        onConfirm={() => void handleResetPassword()}
        onCancel={() => setResetTarget(null)}
      >
        <div>
          <label htmlFor="reset-pwd-input" className="block text-xs font-medium text-slate-700">
            Mật khẩu tạm thời mới (tối thiểu 6 ký tự)
          </label>
          <input
            id="reset-pwd-input"
            type="text"
            minLength={6}
            value={resetPwd}
            onChange={(e) => setResetPwd(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
          />
        </div>
      </ConfirmModal>
    </div>
  );
}
