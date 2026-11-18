import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Award,
  CheckCircle2,
  KeyRound,
  Lock,
  LogOut,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useRoomRealtime } from '../hooks/useRoomRealtime';
import { apiFetch } from '../lib/api';
import { usePageEnter, useStaggerReveal } from '../lib/gsap';
import { RoomStatusText } from '../components/StatusText';
import { ChangePasswordModal } from '../components/ChangePasswordModal';
import { ConfirmModal } from '../components/ConfirmModal';
import type { GroupResultEntry, RoomStatus, RubricCriterionDef } from '../lib/domain';

interface StudentRoomSummary {
  id: string;
  name: string;
  room_code: string;
  classroom_name: string;
  session_date: string;
  status: RoomStatus;
  group_count: number;
  allow_student_selection: number;
  publish_results: number;
}

interface RoomGroupMember {
  user_id: string;
  username: string;
  full_name: string | null;
  student_code: string | null;
  approval_status: string;
}

interface RoomGroup {
  id: string;
  name: string;
  description: string;
  max_capacity: number;
  presentation_order: number;
  leader_user_id: string | null;
  leader_name: string | null;
  is_locked: number;
  memberCount: number;
  remainingCapacity: number;
  members: RoomGroupMember[];
}

interface RoomDetailPayload {
  room: StudentRoomSummary & {
    description: string;
    require_admin_approval: number;
    publish_feedback: number;
  };
  groups: RoomGroup[];
  myGroupMembership: {
    group_id: string;
    approval_status: string;
  } | null;
}

interface ResultsPayload {
  published: boolean;
  criteria: RubricCriterionDef[];
  rankings: GroupResultEntry[];
  groupDetails: Array<{
    groupId: string;
    groupName: string;
    graderAssessments: Array<{
      assessmentId: string;
      graderName: string;
      totalScore: number;
      publicFeedback: string;
      overallComment: string;
      strengths: string;
      weaknesses: string;
      suggestions: string;
    }>;
  }>;
}

export function StudentPortalPage() {
  const { user, logout } = useAuth();
  const pageRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  usePageEnter(pageRef, 'student');

  const [rooms, setRooms] = useState<StudentRoomSummary[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [roomDetail, setRoomDetail] = useState<RoomDetailPayload | null>(null);
  const [results, setResults] = useState<ResultsPayload | null>(null);
  const [activeTab, setActiveTab] = useState<'groups' | 'results'>('groups');

  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirmGroup, setConfirmGroup] = useState<RoomGroup | null>(null);
  const [showPwdModal, setShowPwdModal] = useState(false);

  const loadRooms = useCallback(async () => {
    const data = await apiFetch<{ rooms: StudentRoomSummary[] }>('/api/rooms');
    setRooms(data.rooms);
    setSelectedRoomId((prev) => {
      if (prev && data.rooms.some((r) => r.id === prev)) return prev;
      return data.rooms[0]?.id ?? '';
    });
  }, []);

  const loadRoomDetail = useCallback(async (roomId: string) => {
    if (!roomId) {
      setRoomDetail(null);
      setResults(null);
      return;
    }
    const [detail, resData] = await Promise.all([
      apiFetch<RoomDetailPayload>(`/api/rooms/${roomId}`),
      apiFetch<ResultsPayload>(`/api/rooms/${roomId}/results`).catch(() => null),
    ]);
    setRoomDetail(detail);
    setResults(resData);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await loadRooms();
      } catch (err) {
        if (active) {
          setMessage({
            type: 'error',
            text: err instanceof Error ? err.message : 'Không thể tải danh sách phòng.',
          });
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadRooms]);

  useEffect(() => {
    if (selectedRoomId) {
      void loadRoomDetail(selectedRoomId);
    }
  }, [selectedRoomId, loadRoomDetail]);

  const handleRealtimeEvent = useCallback(() => {
    if (selectedRoomId) {
      void loadRoomDetail(selectedRoomId);
    }
  }, [selectedRoomId, loadRoomDetail]);

  const { connectionState } = useRoomRealtime(selectedRoomId || undefined, handleRealtimeEvent);

  useStaggerReveal(gridRef, '.group-card-item', roomDetail?.room.id);

  const handleJoinByCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomCodeInput.trim()) return;
    setActionBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch<{ roomId: string; name: string }>('/api/rooms/join-by-code', {
        method: 'POST',
        body: JSON.stringify({ roomCode: roomCodeInput.trim() }),
      });
      setRoomCodeInput('');
      await loadRooms();
      setSelectedRoomId(res.roomId);
      setMessage({ type: 'success', text: `Đã tham gia phòng "${res.name}".` });
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Không thể tham gia phòng bằng mã.',
      });
    } finally {
      setActionBusy(false);
    }
  };

  const handleConfirmJoinGroup = async () => {
    if (!confirmGroup || !selectedRoomId) return;
    setActionBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch<{ groupName: string; approvalStatus?: string }>(
        `/api/rooms/${selectedRoomId}/groups/${confirmGroup.id}/join`,
        { method: 'POST' }
      );
      setConfirmGroup(null);
      await loadRoomDetail(selectedRoomId);
      setMessage({
        type: 'success',
        text:
          res.approvalStatus === 'PENDING'
            ? `Đã gửi yêu cầu vào ${res.groupName}, chờ giáo viên duyệt.`
            : `Bạn đã gia nhập ${res.groupName} thành công.`,
      });
    } catch (err) {
      setConfirmGroup(null);
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Không thể chọn nhóm.',
      });
      await loadRoomDetail(selectedRoomId);
    } finally {
      setActionBusy(false);
    }
  };

  const myGroup = roomDetail?.groups.find(
    (g) => g.id === roomDetail.myGroupMembership?.group_id
  );
  const canSelfSelect =
    roomDetail?.room.status === 'REGISTRATION_OPEN' &&
    roomDetail?.room.allow_student_selection === 1;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top Bar Contract: 3 zones */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 py-3.5 sm:px-6">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            Lớp 12A17
          </span>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <button
              type="button"
              onClick={() => setActiveTab('groups')}
              className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors ${
                activeTab === 'groups'
                  ? 'border-b-2 border-indigo-600 text-slate-900'
                  : 'hover:text-slate-900'
              }`}
            >
              Nhóm thuyết trình
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('results')}
              className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors ${
                activeTab === 'results'
                  ? 'border-b-2 border-indigo-600 text-slate-900'
                  : 'hover:text-slate-900'
              }`}
            >
              Kết quả &amp; Nhận xét
            </button>
            <button
              type="button"
              onClick={() => setShowPwdModal(true)}
              className="whitespace-nowrap shrink-0 text-slate-600 hover:text-slate-900"
            >
              Đổi mật khẩu
            </button>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden sm:inline text-xs font-medium text-slate-600 whitespace-nowrap">
              {user?.studentCode || user?.username} · {user?.fullName}
            </span>
            <button
              type="button"
              onClick={() => void logout()}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Đăng xuất</span>
            </button>
          </div>
        </div>
      </header>

      <main ref={pageRef} className="mx-auto max-w-6xl px-4 py-6 sm:px-6 space-y-6">
        {/* Mobile navigation tabs */}
        <div className="flex items-center gap-2 md:hidden">
          <button
            type="button"
            onClick={() => setActiveTab('groups')}
            className={`flex-1 min-h-[44px] rounded-md px-3 py-2 text-sm font-medium ${
              activeTab === 'groups'
                ? 'bg-indigo-600 text-white'
                : 'border border-slate-200 bg-white text-slate-700'
            }`}
          >
            Nhóm thuyết trình
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('results')}
            className={`flex-1 min-h-[44px] rounded-md px-3 py-2 text-sm font-medium ${
              activeTab === 'results'
                ? 'bg-indigo-600 text-white'
                : 'border border-slate-200 bg-white text-slate-700'
            }`}
          >
            Kết quả
          </button>
          <button
            type="button"
            onClick={() => setShowPwdModal(true)}
            aria-label="Đổi mật khẩu"
            className="min-h-[44px] rounded-md border border-slate-200 bg-white px-3 py-2 text-slate-700"
          >
            <KeyRound className="h-4 w-4" />
          </button>
        </div>

        {/* Room selector & join by code */}
        <section className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex-1 min-w-0">
              <label htmlFor="student-room-select" className="block text-xs font-medium text-slate-500">
                Phòng thuyết trình của bạn
              </label>
              <select
                id="student-room-select"
                value={selectedRoomId}
                onChange={(e) => setSelectedRoomId(e.target.value)}
                className="mt-1.5 w-full max-w-xl rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
              >
                {rooms.length === 0 && <option value="">Chưa có phòng nào</option>}
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.room_code}) — {r.classroom_name}
                  </option>
                ))}
              </select>
            </div>

            <form onSubmit={handleJoinByCode} className="flex items-end gap-2">
              <div>
                <label htmlFor="join-room-code" className="block text-xs font-medium text-slate-500">
                  Tham gia bằng mã phòng
                </label>
                <input
                  id="join-room-code"
                  type="text"
                  placeholder="Nhập mã (VD: 12A17-GK01)"
                  value={roomCodeInput}
                  onChange={(e) => setRoomCodeInput(e.target.value)}
                  className="mt-1.5 w-48 rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm uppercase placeholder:normal-case text-slate-900 focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
                />
              </div>
              <button
                type="submit"
                disabled={actionBusy || !roomCodeInput.trim()}
                className="min-h-[40px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
              >
                Vào phòng
              </button>
            </form>
          </div>

          {roomDetail && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-xs text-slate-600">
              <div className="flex flex-wrap items-center gap-2">
                <RoomStatusText status={roomDetail.room.status} />
                <span aria-hidden="true">·</span>
                <span>Ngày: {roomDetail.room.session_date}</span>
                <span aria-hidden="true">·</span>
                <span>Mã phòng: <strong className="font-mono text-slate-800">{roomDetail.room.room_code}</strong></span>
              </div>
              <div className="inline-flex items-center gap-1.5 text-xs">
                {connectionState === 'connected' ? (
                  <>
                    <Wifi className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                    <span className="text-emerald-700">Đồng bộ trực tiếp</span>
                  </>
                ) : (
                  <>
                    <WifiOff className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                    <span className="text-amber-700">Đang kết nối lại...</span>
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        {message && (
          <div
            role="status"
            className={`rounded-md border px-4 py-3 text-sm ${
              message.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {message.text}
          </div>
        )}

        {loading ? (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            Đang tải dữ liệu phòng thuyết trình...
          </div>
        ) : !roomDetail ? (
          <div className="rounded-lg border border-slate-200 bg-white p-10 text-center">
            <Users className="mx-auto h-8 w-8 text-slate-400" aria-hidden="true" />
            <h2 className="mt-3 text-base font-semibold text-slate-900">
              Bạn chưa tham gia phòng thuyết trình nào
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Nhập mã phòng do giáo viên cung cấp ở phía trên để vào chọn nhóm.
            </p>
          </div>
        ) : activeTab === 'groups' ? (
          <div className="space-y-6">
            {/* My group summary banner */}
            <section className="rounded-lg border border-slate-200 bg-white p-5">
              {myGroup ? (
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-xs font-medium text-indigo-700">
                      Nhóm hiện tại của bạn · Thứ tự thuyết trình #{myGroup.presentation_order}
                    </div>
                    <h2 className="mt-1 font-display text-xl font-bold text-slate-900">
                      {myGroup.name}
                      {myGroup.description ? ` — ${myGroup.description}` : ''}
                    </h2>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
                      {myGroup.members.map((m) => (
                        <span key={m.user_id} className={m.user_id === user?.id ? 'font-semibold text-slate-900' : ''}>
                          {m.student_code || m.username} ({m.full_name || m.username})
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      <span>
                        {roomDetail.myGroupMembership?.approval_status === 'PENDING'
                          ? 'Đang chờ giáo viên duyệt'
                          : 'Đã xác nhận thành viên'}
                      </span>
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="font-display text-lg font-semibold text-slate-900">
                      Bạn chưa thuộc nhóm nào trong phòng này
                    </h2>
                    <p className="mt-1 text-sm text-slate-600">
                      {canSelfSelect
                        ? 'Hãy chọn một nhóm còn chỗ trống bên dưới để tham gia.'
                        : 'Chức năng tự chọn nhóm hiện đang đóng. Vui lòng liên hệ giáo viên.'}
                    </p>
                  </div>
                </div>
              )}
            </section>

            {/* Available groups grid */}
            <section ref={gridRef} className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
              {roomDetail.groups.map((group) => {
                const isMine = group.id === myGroup?.id;
                const isFull = group.remainingCapacity <= 0;
                const locked = group.is_locked === 1 || !canSelfSelect;

                return (
                  <article
                    key={group.id}
                    className={`group-card-item flex flex-col justify-between rounded-lg border bg-white p-4 transition-colors ${
                      isMine ? 'border-indigo-600 ring-1 ring-indigo-600/20' : 'border-slate-200'
                    }`}
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-xs text-slate-500">
                            Thứ tự #{group.presentation_order}
                          </div>
                          <h3 className="mt-0.5 font-display text-base font-semibold text-slate-900">
                            {group.name}
                          </h3>
                        </div>
                        <span
                          className={`font-mono text-xs font-semibold tabular-nums ${
                            isFull ? 'text-slate-500' : 'text-emerald-700'
                          }`}
                        >
                          {group.memberCount}/{group.max_capacity}
                        </span>
                      </div>

                      {group.description && (
                        <p className="mt-1.5 text-xs leading-relaxed text-slate-600 line-clamp-2">
                          {group.description}
                        </p>
                      )}

                      <div className="mt-3 border-t border-slate-100 pt-2.5">
                        <div className="text-xs font-medium text-slate-500 mb-1.5">
                          {isFull ? 'Đã đủ thành viên' : `Còn ${group.remainingCapacity} chỗ trống`}
                        </div>
                        {group.members.length === 0 ? (
                          <div className="text-xs text-slate-400">Chưa có thành viên</div>
                        ) : (
                          <ul className="space-y-1 text-xs text-slate-700">
                            {group.members.map((m) => (
                              <li key={m.user_id} className="flex items-center justify-between gap-2">
                                <span className="truncate">
                                  <span className="font-mono text-slate-500 mr-1.5">
                                    {m.student_code || m.username}
                                  </span>
                                  {m.full_name || m.username}
                                </span>
                                {group.leader_user_id === m.user_id && (
                                  <span className="text-[11px] font-medium text-indigo-700 shrink-0">
                                    Trưởng nhóm
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-100">
                      {isMine ? (
                        <div className="flex min-h-[40px] items-center justify-center gap-1.5 rounded-md bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700">
                          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                          <span>Nhóm của bạn</span>
                        </div>
                      ) : locked ? (
                        <div className="flex min-h-[40px] items-center justify-center gap-1.5 rounded-md bg-slate-100 px-3 py-2 text-xs font-medium text-slate-500">
                          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Đã khóa chọn nhóm</span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={isFull || actionBusy}
                          onClick={() => setConfirmGroup(group)}
                          className="min-h-[44px] w-full rounded-md border border-indigo-600 bg-white px-3 py-2 text-xs font-semibold text-indigo-600 transition-colors hover:bg-indigo-600 hover:text-white disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                        >
                          {isFull ? 'Nhóm đã đầy' : `Chọn ${group.name}`}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </section>
          </div>
        ) : (
          /* Student Results & Public Feedback Tab */
          <section className="space-y-4">
            {!results || !results.published ? (
              <div className="rounded-lg border border-slate-200 bg-white p-10 text-center">
                <Award className="mx-auto h-8 w-8 text-slate-400" aria-hidden="true" />
                <h2 className="mt-3 text-base font-semibold text-slate-900">
                  Kết quả chưa được công bố
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Giáo viên sẽ công bố bảng điểm và xếp hạng chính thức sau khi hoàn tất chấm điểm.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <tr>
                        <th className="px-4 py-3">Hạng</th>
                        <th className="px-4 py-3">Nhóm</th>
                        <th className="px-4 py-3 text-right">Thành viên</th>
                        <th className="px-4 py-3 text-right">Điểm tổng kết</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {results.rankings.map((r) => (
                        <tr key={r.groupId} className={r.groupId === myGroup?.id ? 'bg-indigo-50/50' : ''}>
                          <td className="px-4 py-3 font-mono font-semibold tabular-nums text-slate-900">
                            {r.rank ? `#${r.rank}${r.isTied ? ' (Đồng hạng)' : ''}` : '—'}
                          </td>
                          <td className="px-4 py-3 font-medium text-slate-900">
                            {r.groupName}
                            {r.groupId === myGroup?.id && (
                              <span className="ml-2 text-xs font-semibold text-indigo-700">
                                (Nhóm của bạn)
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600">
                            {r.memberCount}
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums text-slate-900">
                            {r.finalScore !== null ? r.finalScore : 'Chưa có'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {myGroup && (
                  <div className="rounded-lg border border-slate-200 bg-white p-5">
                    <h3 className="font-display text-base font-semibold text-slate-900">
                      Nhận xét công khai dành cho {myGroup.name}
                    </h3>
                    {(() => {
                      const detail = results.groupDetails.find((g) => g.groupId === myGroup.id);
                      if (!detail || detail.graderAssessments.length === 0) {
                        return (
                          <p className="mt-2 text-sm text-slate-500">
                            Chưa có nhận xét công khai cho nhóm bạn.
                          </p>
                        );
                      }
                      return (
                        <div className="mt-3 divide-y divide-slate-100">
                          {detail.graderAssessments.map((ga) => (
                            <div key={ga.assessmentId} className="py-3 first:pt-0 last:pb-0 space-y-1.5">
                              <div className="flex items-center justify-between text-xs text-slate-500">
                                <span className="font-medium text-slate-800">{ga.graderName}</span>
                                <span className="font-mono font-semibold tabular-nums text-slate-900">
                                  {ga.totalScore} điểm
                                </span>
                              </div>
                              {ga.publicFeedback && (
                                <p className="text-sm text-slate-700">{ga.publicFeedback}</p>
                              )}
                              {ga.overallComment && !ga.publicFeedback && (
                                <p className="text-sm text-slate-700">{ga.overallComment}</p>
                              )}
                              {ga.strengths && (
                                <p className="text-xs text-emerald-700">
                                  <strong>Điểm mạnh:</strong> {ga.strengths}
                                </p>
                              )}
                              {ga.suggestions && (
                                <p className="text-xs text-indigo-700">
                                  <strong>Đề xuất cải thiện:</strong> {ga.suggestions}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </main>

      <ConfirmModal
        open={Boolean(confirmGroup)}
        title={`Xác nhận chọn ${confirmGroup?.name ?? ''}`}
        description={
          myGroup
            ? `Bạn sẽ chuyển từ ${myGroup.name} sang ${confirmGroup?.name}. Hệ thống kiểm tra chỗ trống theo thời gian thực.`
            : `Bạn muốn gia nhập ${confirmGroup?.name} (còn ${confirmGroup?.remainingCapacity ?? 0} chỗ trống)?`
        }
        confirmLabel="Xác nhận vào nhóm"
        busy={actionBusy}
        onConfirm={() => void handleConfirmJoinGroup()}
        onCancel={() => setConfirmGroup(null)}
      />

      <ChangePasswordModal
        open={showPwdModal || Boolean(user?.mustChangePassword)}
        forced={Boolean(user?.mustChangePassword)}
        onClose={() => setShowPwdModal(false)}
      />
    </div>
  );
}
