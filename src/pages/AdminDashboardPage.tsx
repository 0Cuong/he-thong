import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Award,
  BookOpen,
  ClipboardCheck,
  DoorOpen,
  FileText,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Play,
  Plus,
  Settings,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { apiFetch, formatViDateTime } from '../lib/api';
import { ROLE_LABELS, type MultiGraderPolicy, type RoomStatus } from '../lib/domain';
import { usePageEnter } from '../lib/gsap';
import { RoomStatusText } from '../components/StatusText';
import { ConfirmModal } from '../components/ConfirmModal';
import { ChangePasswordModal } from '../components/ChangePasswordModal';
import { StudentsManager } from '../components/admin/StudentsManager';
import { GroupManager } from '../components/admin/GroupManager';
import { RubricEditor } from '../components/admin/RubricEditor';
import { ResultsPage } from './ResultsPage';
import { LiveScoringPage } from './LiveScoringPage';

type AdminTab =
  | 'overview'
  | 'classrooms'
  | 'rooms'
  | 'students'
  | 'staff'
  | 'groups'
  | 'rubric'
  | 'scoring'
  | 'results'
  | 'audits'
  | 'settings';

interface OverviewStats {
  classroomCount: number;
  studentCount: number;
  totalStudents: number;
  graderCount: number;
  activeRooms: number;
  totalGroups: number;
  completedAssessments: number;
  pendingAssessments: number;
}

interface ClassroomItem {
  id: string;
  name: string;
  code: string;
  academic_year: string;
  description: string;
  status: 'ACTIVE' | 'ARCHIVED';
  student_count: number;
  room_count: number;
}

interface RoomItem {
  id: string;
  classroom_id: string;
  classroom_name: string;
  name: string;
  room_code: string;
  description: string;
  session_date: string;
  status: RoomStatus;
  group_count: number;
  student_count: number;
  scored_group_count: number;
  allow_student_selection: number;
  multi_grader_policy: MultiGraderPolicy;
  publish_results: number;
  publish_feedback: number;
}

const NAV_ITEMS: Array<{
  id: AdminTab;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'overview', label: 'Tổng quan', Icon: LayoutDashboard },
  { id: 'classrooms', label: 'Lớp học', Icon: BookOpen },
  { id: 'rooms', label: 'Phòng thuyết trình', Icon: DoorOpen },
  { id: 'students', label: 'Tài khoản Học sinh', Icon: Users },
  { id: 'staff', label: 'Giáo viên & Giám khảo', Icon: ShieldCheck },
  { id: 'groups', label: 'Quản lý Nhóm', Icon: ListChecks },
  { id: 'rubric', label: 'Tiêu chí chấm điểm', Icon: FileText },
  { id: 'scoring', label: 'Chấm điểm trực tiếp', Icon: ClipboardCheck },
  { id: 'results', label: 'Kết quả & Báo cáo', Icon: Award },
  { id: 'audits', label: 'Nhật ký hệ thống', Icon: FileText },
  { id: 'settings', label: 'Cài đặt', Icon: Settings },
];

export function AdminDashboardPage() {
  const { user, logout } = useAuth();
  const mainRef = useRef<HTMLDivElement>(null);

  const [tab, setTab] = useState<AdminTab>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showPwdModal, setShowPwdModal] = useState(false);

  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [recentAudits, setRecentAudits] = useState<any[]>([]);
  const [classrooms, setClassrooms] = useState<ClassroomItem[]>([]);
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [staffUsers, setStaffUsers] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});

  // Forms
  const [newClassForm, setNewClassForm] = useState({
    name: '',
    code: '',
    academicYear: '2026-2027',
    description: '',
  });
  const [showNewClass, setShowNewClass] = useState(false);

  const [newRoomForm, setNewRoomForm] = useState({
    classroomId: '',
    name: '',
    roomCode: '',
    sessionDate: new Date().toISOString().slice(0, 10),
    groupCount: 8,
    groupCapacity: 6,
    description: '',
  });
  const [showNewRoom, setShowNewRoom] = useState(false);

  const [newStaffForm, setNewStaffForm] = useState({
    username: '',
    fullName: '',
    email: '',
    password: 'Grader@1234',
    role: 'GRADER' as 'GRADER' | 'TEACHER',
  });
  const [showNewStaff, setShowNewStaff] = useState(false);

  const [reopenConfirmRoomId, setReopenConfirmRoomId] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  usePageEnter(mainRef, tab);

  const loadCoreData = useCallback(async () => {
    try {
      const [ov, cls, rms] = await Promise.all([
        apiFetch<{ stats: OverviewStats; recentAudits: any[] }>('/api/admin/overview'),
        apiFetch<{ classrooms: ClassroomItem[] }>('/api/classrooms'),
        apiFetch<{ rooms: RoomItem[] }>('/api/rooms'),
      ]);
      setStats(ov.stats);
      setRecentAudits(ov.recentAudits);
      setClassrooms(cls.classrooms);
      setRooms(rms.rooms);
      setSelectedRoomId((prev) => {
        if (prev && rms.rooms.some((r) => r.id === prev)) return prev;
        return rms.rooms[0]?.id ?? '';
      });
      setNewRoomForm((f) => ({
        ...f,
        classroomId: f.classroomId || cls.classrooms[0]?.id || '',
      }));
    } catch (err) {
      setNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'Không thể tải dữ liệu bảng điều khiển.',
      });
    }
  }, []);

  useEffect(() => {
    void loadCoreData();
  }, [loadCoreData]);

  useEffect(() => {
    const onErr = (err: unknown) => {
      setNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'Không thể tải dữ liệu mục này.',
      });
    };
    if (tab === 'staff') {
      void apiFetch<{ users: any[] }>('/api/users?limit=100')
        .then((res) => {
          setStaffUsers(res.users.filter((u) => u.role !== 'STUDENT'));
        })
        .catch(onErr);
    } else if (tab === 'audits') {
      void apiFetch<{ logs: any[] }>('/api/audit-logs?limit=100')
        .then((res) => {
          setAuditLogs(res.logs);
        })
        .catch(onErr);
    } else if (tab === 'settings') {
      void apiFetch<{ settings: Record<string, string> }>('/api/settings')
        .then((res) => {
          setSettings(res.settings);
        })
        .catch(onErr);
    }
  }, [tab]);

  const activeRoom = rooms.find((r) => r.id === selectedRoomId) ?? null;

  const handleCreateClassroom = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await apiFetch('/api/classrooms', {
        method: 'POST',
        body: JSON.stringify(newClassForm),
      });
      setShowNewClass(false);
      setNewClassForm({ name: '', code: '', academicYear: '2026-2027', description: '' });
      setNotice({ type: 'success', text: 'Đã tạo lớp học mới.' });
      await loadCoreData();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Tạo lớp thất bại.' });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const created = await apiFetch<{ room: RoomItem }>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify(newRoomForm),
      });
      setShowNewRoom(false);
      setNewRoomForm((f) => ({ ...f, name: '', roomCode: '', description: '' }));
      setNotice({ type: 'success', text: 'Đã tạo phòng thuyết trình và rubric mặc định.' });
      await loadCoreData();
      setSelectedRoomId(created.room.id);
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Tạo phòng thất bại.' });
    } finally {
      setBusy(false);
    }
  };

  const handleRoomTransition = async (
    roomId: string,
    targetStatus: RoomStatus,
    reopenConfirmed = false,
    reason = ''
  ) => {
    setBusy(true);
    setNotice(null);
    try {
      await apiFetch(`/api/rooms/${roomId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, reopenConfirmed, reason }),
      });
      setReopenConfirmRoomId(null);
      setReopenReason('');
      setNotice({ type: 'success', text: 'Đã cập nhật trạng thái phòng thuyết trình.' });
      await loadCoreData();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Chuyển trạng thái thất bại.' });
    } finally {
      setBusy(false);
    }
  };

  const handleRoomPolicyChange = async (
    roomId: string,
    patch: {
      multiGraderPolicy?: MultiGraderPolicy;
      publishResults?: boolean;
      publishFeedback?: boolean;
    }
  ) => {
    setBusy(true);
    try {
      await apiFetch(`/api/rooms/${roomId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await loadCoreData();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Cập nhật thất bại.' });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify(newStaffForm),
      });
      setShowNewStaff(false);
      setNewStaffForm({
        username: '',
        fullName: '',
        email: '',
        password: 'Grader@1234',
        role: 'GRADER',
      });
      const res = await apiFetch<{ users: any[] }>('/api/users?limit=100');
      setStaffUsers(res.users.filter((u) => u.role !== 'STUDENT'));
      setNotice({ type: 'success', text: 'Đã tạo tài khoản giáo viên / giám khảo.' });
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Không thể tạo tài khoản.' });
    } finally {
      setBusy(false);
    }
  };

  const handleAssignGraderToRoom = async (userId: string) => {
    if (!selectedRoomId) return;
    setBusy(true);
    try {
      await apiFetch(`/api/rooms/${selectedRoomId}/graders`, {
        method: 'POST',
        body: JSON.stringify({ userId, graderWeight: 1 }),
      });
      setNotice({ type: 'success', text: 'Đã phân công giám khảo vào phòng đang chọn.' });
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Phân công thất bại.' });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ settings }),
      });
      setNotice({ type: 'success', text: 'Đã lưu cấu hình hệ thống.' });
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Không thể lưu cài đặt.' });
    } finally {
      setBusy(false);
    }
  };

  const SidebarContent = (
    <div className="flex h-full flex-col justify-between p-4">
      <div className="space-y-6">
        <div className="px-2">
          <div className="font-display text-lg font-bold tracking-tight text-slate-900">
            Lớp 12A17
          </div>
          <div className="text-xs text-slate-500">
            {ROLE_LABELS[user?.role ?? 'TEACHER']}
          </div>
        </div>

        <nav aria-label="Điều hướng quản trị" className="space-y-1">
          {NAV_ITEMS.map(({ id, label, Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setTab(id);
                  setMobileMenuOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="border-t border-slate-200 pt-3 space-y-1.5">
        <div className="px-2 text-xs font-medium text-slate-800 truncate">{user?.fullName}</div>
        <button
          type="button"
          onClick={() => setShowPwdModal(true)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
        >
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Đổi mật khẩu</span>
        </button>
        <button
          type="button"
          onClick={() => void logout()}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-red-700 hover:bg-red-50"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Đăng xuất</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar (248px) */}
      <aside className="hidden lg:block w-[248px] shrink-0 border-r border-slate-200 bg-white">
        <div className="sticky top-0 h-screen overflow-y-auto">{SidebarContent}</div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-10 w-64 bg-white border-r border-slate-200 h-full overflow-y-auto">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Đóng menu"
              className="absolute right-3 top-3 rounded p-1.5 text-slate-500 hover:bg-slate-100"
            >
              <X className="h-5 w-5" />
            </button>
            {SidebarContent}
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                aria-label="Mở menu điều hướng"
                className="lg:hidden rounded-md border border-slate-300 p-2 text-slate-700"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <div className="text-xs text-slate-500">
                  Quản trị Lớp học / {NAV_ITEMS.find((n) => n.id === tab)?.label}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <label htmlFor="admin-room-picker" className="sr-only">
                    Phòng đang thao tác
                  </label>
                  <select
                    id="admin-room-picker"
                    value={selectedRoomId}
                    onChange={(e) => setSelectedRoomId(e.target.value)}
                    className="max-w-xs sm:max-w-md rounded border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-900"
                  >
                    {rooms.length === 0 && <option value="">Chưa có phòng</option>}
                    {rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.room_code})
                      </option>
                    ))}
                  </select>
                  {activeRoom && <RoomStatusText status={activeRoom.status} />}
                </div>
              </div>
            </div>

            {selectedRoomId && (
              <Link
                to={`/score/${selectedRoomId}`}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 whitespace-nowrap shrink-0"
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Mở màn hình chấm điểm</span>
              </Link>
            )}
          </div>
        </header>

        <main ref={mainRef} className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto space-y-6">
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

          {/* OVERVIEW */}
          {tab === 'overview' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="text-xs text-slate-500">Học sinh hoạt động</div>
                  <div className="mt-1 font-display text-2xl font-bold tabular-nums text-slate-900">
                    {stats?.studentCount ?? 0}
                    <span className="text-xs font-normal text-slate-400">/{stats?.totalStudents ?? 0}</span>
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="text-xs text-slate-500">Phòng đang hoạt động</div>
                  <div className="mt-1 font-display text-2xl font-bold tabular-nums text-indigo-700">
                    {stats?.activeRooms ?? 0}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="text-xs text-slate-500">Tổng số nhóm</div>
                  <div className="mt-1 font-display text-2xl font-bold tabular-nums text-slate-900">
                    {stats?.totalGroups ?? 0}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="text-xs text-slate-500">Phiếu đã nộp</div>
                  <div className="mt-1 font-display text-2xl font-bold tabular-nums text-emerald-700">
                    {stats?.completedAssessments ?? 0}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="text-xs text-slate-500">Phiếu đang chấm</div>
                  <div className="mt-1 font-display text-2xl font-bold tabular-nums text-amber-700">
                    {stats?.pendingAssessments ?? 0}
                  </div>
                </div>
              </div>

              {/* Quick Classroom Actions */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <button
                  type="button"
                  onClick={() => setTab('students')}
                  className="rounded-lg border border-slate-200 bg-white p-5 text-left hover:border-indigo-400 transition-colors"
                >
                  <div className="text-sm font-semibold text-slate-900">
                    1. Tài khoản 48 Học sinh
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    Tạo nhanh HS001–HS048, nhập từ CSV/Excel, đặt lại mật khẩu và theo dõi đăng nhập.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('groups')}
                  className="rounded-lg border border-slate-200 bg-white p-5 text-left hover:border-indigo-400 transition-colors"
                >
                  <div className="text-sm font-semibold text-slate-900">
                    2. Chia nhóm thông minh (8 nhóm)
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    Phân chia đều tự động, mở/đóng cho học sinh tự chọn hoặc điều chỉnh thủ công.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('scoring')}
                  className="rounded-lg border border-slate-200 bg-white p-5 text-left hover:border-indigo-400 transition-colors"
                >
                  <div className="text-sm font-semibold text-slate-900">
                    3. Chấm điểm trực tiếp &amp; Xếp hạng
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    Chấm bài live theo rubric, lưu nháp tự động, chốt kết quả và xuất Excel/PDF.
                  </p>
                </button>
              </div>

              {/* Recent Real Audit Activities */}
              <div className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
                  <h2 className="text-sm font-semibold text-slate-900">Hoạt động gần đây</h2>
                  <button
                    type="button"
                    onClick={() => setTab('audits')}
                    className="text-xs font-medium text-indigo-600 hover:underline"
                  >
                    Xem tất cả
                  </button>
                </div>
                <div className="divide-y divide-slate-100">
                  {recentAudits.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500">Chưa có hoạt động nào.</div>
                  ) : (
                    recentAudits.map((log) => (
                      <div
                        key={log.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-xs"
                      >
                        <div>
                          <span className="font-mono font-semibold text-slate-800">{log.actor_username}</span>
                          <span className="mx-1.5 text-slate-400">·</span>
                          <span className="font-medium text-slate-700">{log.action}</span>
                          <span className="mx-1.5 text-slate-400">·</span>
                          <span className="text-slate-500">{log.entity_type}</span>
                        </div>
                        <span className="font-mono tabular-nums text-slate-400">
                          {formatViDateTime(log.created_at)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* CLASSROOMS */}
          {tab === 'classrooms' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-xl font-bold text-slate-900">Danh sách Lớp học</h2>
                <button
                  type="button"
                  onClick={() => setShowNewClass((v) => !v)}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>Tạo lớp mới</span>
                </button>
              </div>

              {showNewClass && (
                <form
                  onSubmit={handleCreateClassroom}
                  className="rounded-lg border border-indigo-200 bg-white p-5 space-y-4"
                >
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Tên lớp học</label>
                      <input
                        type="text"
                        required
                        placeholder="VD: Lớp 12A17"
                        value={newClassForm.name}
                        onChange={(e) => setNewClassForm((f) => ({ ...f, name: e.target.value }))}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Mã lớp</label>
                      <input
                        type="text"
                        required
                        placeholder="12A17"
                        value={newClassForm.code}
                        onChange={(e) => setNewClassForm((f) => ({ ...f, code: e.target.value }))}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm uppercase placeholder:normal-case"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Năm học</label>
                      <input
                        type="text"
                        value={newClassForm.academicYear}
                        onChange={(e) => setNewClassForm((f) => ({ ...f, academicYear: e.target.value }))}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowNewClass(false)}
                      className="rounded-md border border-slate-300 px-4 py-2 text-xs"
                    >
                      Hủy
                    </button>
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white"
                    >
                      Lưu lớp học
                    </button>
                  </div>
                </form>
              )}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {classrooms.map((c) => (
                  <div key={c.id} className="rounded-lg border border-slate-200 bg-white p-5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-mono text-xs font-semibold text-indigo-700">
                          {c.code} · {c.academic_year}
                        </div>
                        <h3 className="mt-1 font-display text-base font-bold text-slate-900">{c.name}</h3>
                      </div>
                      <span className="text-xs font-medium text-slate-500">
                        {c.status === 'ACTIVE' ? 'Đang hoạt động' : 'Đã lưu trữ'}
                      </span>
                    </div>
                    {c.description && <p className="mt-2 text-xs text-slate-600">{c.description}</p>}
                    <div className="mt-4 flex items-center gap-4 border-t border-slate-100 pt-3 text-xs text-slate-600 tabular-nums">
                      <span>{c.student_count} học sinh</span>
                      <span>·</span>
                      <span>{c.room_count} phòng thuyết trình</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PRESENTATION ROOMS & LIFECYCLE */}
          {tab === 'rooms' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-display text-xl font-bold text-slate-900">
                    Quản lý Phòng thuyết trình &amp; Trạng thái phiên
                  </h2>
                  <p className="text-sm text-slate-600">
                    Mỗi phòng có danh sách nhóm, tiêu chí chấm điểm và chính sách tổng hợp riêng biệt.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowNewRoom((v) => !v)}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 whitespace-nowrap"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>Tạo phòng mới</span>
                </button>
              </div>

              {showNewRoom && (
                <form
                  onSubmit={handleCreateRoom}
                  className="rounded-lg border border-indigo-200 bg-white p-5 space-y-4"
                >
                  <h3 className="text-sm font-semibold text-slate-900">Tạo phòng thuyết trình mới</h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Lớp học</label>
                      <select
                        required
                        value={newRoomForm.classroomId}
                        onChange={(e) => setNewRoomForm((f) => ({ ...f, classroomId: e.target.value }))}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      >
                        {classrooms.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Tên phòng thuyết trình</label>
                      <input
                        type="text"
                        required
                        placeholder="VD: Thuyết trình Cuối kỳ"
                        value={newRoomForm.name}
                        onChange={(e) => setNewRoomForm((f) => ({ ...f, name: e.target.value }))}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Mã phòng (tùy chọn)</label>
                      <input
                        type="text"
                        placeholder="Tự sinh nếu để trống"
                        value={newRoomForm.roomCode}
                        onChange={(e) => setNewRoomForm((f) => ({ ...f, roomCode: e.target.value }))}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm uppercase placeholder:normal-case"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Ngày thuyết trình</label>
                      <input
                        type="date"
                        value={newRoomForm.sessionDate}
                        onChange={(e) => setNewRoomForm((f) => ({ ...f, sessionDate: e.target.value }))}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Số nhóm mặc định</label>
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={newRoomForm.groupCount}
                        onChange={(e) => setNewRoomForm((f) => ({ ...f, groupCount: Number(e.target.value) }))}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Sức chứa mỗi nhóm</label>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={newRoomForm.groupCapacity}
                        onChange={(e) =>
                          setNewRoomForm((f) => ({ ...f, groupCapacity: Number(e.target.value) }))
                        }
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowNewRoom(false)}
                      className="rounded-md border border-slate-300 px-4 py-2 text-xs"
                    >
                      Hủy
                    </button>
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white"
                    >
                      Tạo phòng
                    </button>
                  </div>
                </form>
              )}

              <div className="space-y-4">
                {rooms.map((r) => (
                  <div key={r.id} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span className="font-mono font-semibold text-indigo-700">{r.room_code}</span>
                          <span>·</span>
                          <span>{r.classroom_name}</span>
                          <span>·</span>
                          <span>Ngày {r.session_date}</span>
                          <span>·</span>
                          <RoomStatusText status={r.status} />
                        </div>
                        <h3 className="mt-1 font-display text-lg font-bold text-slate-900">{r.name}</h3>
                        <div className="mt-1 text-xs text-slate-600 tabular-nums">
                          {r.student_count} học sinh · {r.group_count} nhóm · {r.scored_group_count}/{r.group_count} nhóm đã có điểm
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {r.status === 'DRAFT' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRoomTransition(r.id, 'REGISTRATION_OPEN')}
                            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white"
                          >
                            Mở chọn nhóm
                          </button>
                        )}
                        {r.status === 'REGISTRATION_OPEN' && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRoomTransition(r.id, 'REGISTRATION_CLOSED')}
                              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
                            >
                              Đóng chọn nhóm
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRoomTransition(r.id, 'IN_PROGRESS')}
                              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white"
                            >
                              Bắt đầu chấm điểm
                            </button>
                          </>
                        )}
                        {(r.status === 'REGISTRATION_CLOSED' || r.status === 'READY') && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRoomTransition(r.id, 'REGISTRATION_OPEN')}
                              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
                            >
                              Mở lại chọn nhóm
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRoomTransition(r.id, 'IN_PROGRESS')}
                              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white"
                            >
                              Bắt đầu chấm điểm
                            </button>
                          </>
                        )}
                        {r.status === 'IN_PROGRESS' && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRoomTransition(r.id, 'PAUSED')}
                              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800"
                            >
                              Tạm dừng
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRoomTransition(r.id, 'FINALIZED')}
                              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
                            >
                              Chốt &amp; Công bố kết quả
                            </button>
                          </>
                        )}
                        {r.status === 'PAUSED' && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRoomTransition(r.id, 'IN_PROGRESS')}
                              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white"
                            >
                              Tiếp tục chấm điểm
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRoomTransition(r.id, 'FINALIZED')}
                              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
                            >
                              Chốt kết quả
                            </button>
                          </>
                        )}
                        {r.status === 'FINALIZED' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setReopenConfirmRoomId(r.id)}
                            className="rounded-md border border-amber-400 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900"
                          >
                            Mở lại phiên chấm
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-6 border-t border-slate-100 pt-3 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500">Chính sách nhiều giám khảo:</span>
                        <select
                          aria-label={`Chính sách nhiều giám khảo cho ${r.name}`}
                          value={r.multi_grader_policy}
                          onChange={(e) =>
                            void handleRoomPolicyChange(r.id, {
                              multiGraderPolicy: e.target.value as MultiGraderPolicy,
                            })
                          }
                          className="rounded border border-slate-300 px-2 py-1 text-xs font-medium"
                        >
                          <option value="AVERAGE">Trung bình cộng</option>
                          <option value="WEIGHTED_AVERAGE">Trung bình có trọng số</option>
                        </select>
                      </div>

                      <label className="inline-flex items-center gap-1.5 text-slate-700">
                        <input
                          type="checkbox"
                          checked={r.publish_results === 1}
                          onChange={(e) =>
                            void handleRoomPolicyChange(r.id, { publishResults: e.target.checked })
                          }
                          className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600"
                        />
                        <span>Công bố điểm cho học sinh</span>
                      </label>

                      <label className="inline-flex items-center gap-1.5 text-slate-700">
                        <input
                          type="checkbox"
                          checked={r.publish_feedback === 1}
                          onChange={(e) =>
                            void handleRoomPolicyChange(r.id, { publishFeedback: e.target.checked })
                          }
                          className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600"
                        />
                        <span>Hiển thị nhận xét công khai</span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STUDENTS */}
          {tab === 'students' && <StudentsManager classrooms={classrooms} />}

          {/* STAFF / GRADERS */}
          {tab === 'staff' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-display text-xl font-bold text-slate-900">
                    Giáo viên &amp; Giám khảo
                  </h2>
                  <p className="text-sm text-slate-600">
                    Quản lý tài khoản chấm điểm và phân công giám khảo vào phòng thuyết trình đang chọn.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowNewStaff((v) => !v)}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>Thêm Giám khảo</span>
                </button>
              </div>

              {showNewStaff && (
                <form
                  onSubmit={handleCreateStaff}
                  className="rounded-lg border border-indigo-200 bg-white p-5 space-y-4"
                >
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Tên đăng nhập</label>
                      <input
                        type="text"
                        required
                        value={newStaffForm.username}
                        onChange={(e) => setNewStaffForm((f) => ({ ...f, username: e.target.value }))}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Họ và tên</label>
                      <input
                        type="text"
                        required
                        value={newStaffForm.fullName}
                        onChange={(e) => setNewStaffForm((f) => ({ ...f, fullName: e.target.value }))}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Vai trò</label>
                      <select
                        value={newStaffForm.role}
                        onChange={(e) =>
                          setNewStaffForm((f) => ({
                            ...f,
                            role: e.target.value as 'GRADER' | 'TEACHER',
                          }))
                        }
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value="GRADER">Giám khảo</option>
                        {user?.role === 'SUPER_ADMIN' && <option value="TEACHER">Giáo viên</option>}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600">Mật khẩu tạm</label>
                      <input
                        type="text"
                        required
                        minLength={6}
                        value={newStaffForm.password}
                        onChange={(e) => setNewStaffForm((f) => ({ ...f, password: e.target.value }))}
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
                      />
                    </div>
                    <div className="flex items-end">
                      <button
                        type="submit"
                        disabled={busy}
                        className="min-h-[40px] w-full rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white"
                      >
                        Tạo tài khoản
                      </button>
                    </div>
                  </div>
                </form>
              )}

              <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <tr>
                      <th className="px-4 py-3">Tài khoản</th>
                      <th className="px-4 py-3">Họ và tên</th>
                      <th className="px-4 py-3">Vai trò</th>
                      <th className="px-4 py-3 text-right">Phân công vào phòng hiện tại</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {staffUsers.map((su) => (
                      <tr key={su.id}>
                        <td className="px-4 py-3 font-mono font-semibold text-slate-900">{su.username}</td>
                        <td className="px-4 py-3 text-slate-800">{su.full_name}</td>
                        <td className="px-4 py-3 text-xs font-medium text-slate-600">
                          {ROLE_LABELS[su.role as keyof typeof ROLE_LABELS] ?? su.role}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {selectedRoomId && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleAssignGraderToRoom(su.id)}
                              className="rounded border border-indigo-600 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                            >
                              Phân công vào {activeRoom?.room_code}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* GROUPS */}
          {tab === 'groups' && <GroupManager roomId={selectedRoomId} />}

          {/* RUBRIC */}
          {tab === 'rubric' && <RubricEditor roomId={selectedRoomId} />}

          {/* LIVE SCORING EMBEDDED */}
          {tab === 'scoring' && <LiveScoringPage embeddedRoomId={selectedRoomId} />}

          {/* RESULTS EMBEDDED */}
          {tab === 'results' && <ResultsPage embeddedRoomId={selectedRoomId} />}

          {/* AUDIT LOGS */}
          {tab === 'audits' && (
            <div className="space-y-4">
              <h2 className="font-display text-xl font-bold text-slate-900">Nhật ký Kiểm toán Hệ thống</h2>
              <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                    <tr>
                      <th className="px-4 py-3">Thời gian</th>
                      <th className="px-4 py-3">Tài khoản</th>
                      <th className="px-4 py-3">Hành động</th>
                      <th className="px-4 py-3">Đối tượng</th>
                      <th className="px-4 py-3">Chi tiết</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {auditLogs.map((log) => (
                      <tr key={log.id}>
                        <td className="px-4 py-2.5 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                          {formatViDateTime(log.created_at)}
                        </td>
                        <td className="px-4 py-2.5 font-mono font-semibold text-slate-800 whitespace-nowrap">
                          {log.actor_username}
                        </td>
                        <td className="px-4 py-2.5 font-medium text-slate-900 whitespace-nowrap">
                          {log.action}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">
                          {log.entity_type} ({log.entity_id})
                        </td>
                        <td className="px-4 py-2.5 font-mono text-slate-500 max-w-md truncate">
                          {log.details_json}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SETTINGS */}
          {tab === 'settings' && (
            <form
              onSubmit={handleSaveSettings}
              className="max-w-xl rounded-lg border border-slate-200 bg-white p-6 space-y-4"
            >
              <h2 className="font-display text-xl font-bold text-slate-900">Cài đặt Hệ thống</h2>
              <div>
                <label className="block text-xs font-medium text-slate-600">Tên đơn vị / Trường học</label>
                <input
                  type="text"
                  disabled={user?.role !== 'SUPER_ADMIN'}
                  value={settings.institution_name ?? ''}
                  onChange={(e) => setSettings((s) => ({ ...s, institution_name: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600">Sĩ số mặc định</label>
                  <input
                    type="number"
                    disabled={user?.role !== 'SUPER_ADMIN'}
                    value={settings.default_student_count ?? '48'}
                    onChange={(e) => setSettings((s) => ({ ...s, default_student_count: e.target.value }))}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm disabled:bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600">Số nhóm mặc định</label>
                  <input
                    type="number"
                    disabled={user?.role !== 'SUPER_ADMIN'}
                    value={settings.default_group_count ?? '8'}
                    onChange={(e) => setSettings((s) => ({ ...s, default_group_count: e.target.value }))}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm disabled:bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600">SV / nhóm mặc định</label>
                  <input
                    type="number"
                    disabled={user?.role !== 'SUPER_ADMIN'}
                    value={settings.default_group_capacity ?? '6'}
                    onChange={(e) => setSettings((s) => ({ ...s, default_group_capacity: e.target.value }))}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm disabled:bg-slate-50"
                  />
                </div>
              </div>
              {user?.role === 'SUPER_ADMIN' ? (
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                >
                  Lưu cài đặt
                </button>
              ) : (
                <p className="text-xs text-slate-500">
                  Chỉ Quản trị hệ thống (Super Admin) mới có quyền chỉnh sửa cấu hình toàn hệ thống.
                </p>
              )}
            </form>
          )}
        </main>
      </div>

      <ConfirmModal
        open={Boolean(reopenConfirmRoomId)}
        title="Xác nhận mở lại phiên chấm điểm"
        description="Phòng này đã chốt kết quả. Mở lại phiên cho phép giám khảo hiệu chỉnh điểm và mọi thay đổi sẽ được ghi lại trong nhật ký kiểm toán."
        confirmLabel="Xác nhận mở lại"
        variant="danger"
        busy={busy}
        onConfirm={() =>
          reopenConfirmRoomId &&
          void handleRoomTransition(reopenConfirmRoomId, 'IN_PROGRESS', true, reopenReason)
        }
        onCancel={() => {
          setReopenConfirmRoomId(null);
          setReopenReason('');
        }}
      >
        <div>
          <label className="block text-xs font-medium text-slate-700">Lý do mở lại phiên</label>
          <input
            type="text"
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value)}
            placeholder="Ví dụ: Phúc khảo điểm Nhóm 3"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      </ConfirmModal>

      <ChangePasswordModal
        open={showPwdModal || Boolean(user?.mustChangePassword)}
        forced={Boolean(user?.mustChangePassword)}
        onClose={() => setShowPwdModal(false)}
      />
    </div>
  );
}
