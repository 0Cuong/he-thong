import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Award, ClipboardCheck, KeyRound, LogOut } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { apiFetch } from '../lib/api';
import { usePageEnter } from '../lib/gsap';
import { RoomStatusText } from '../components/StatusText';
import { ChangePasswordModal } from '../components/ChangePasswordModal';
import type { RoomStatus } from '../lib/domain';

interface GraderRoomItem {
  id: string;
  name: string;
  room_code: string;
  classroom_name: string;
  session_date: string;
  status: RoomStatus;
  group_count: number;
  scored_group_count: number;
}

export function GraderDashboardPage() {
  const { user, logout } = useAuth();
  const pageRef = useRef<HTMLDivElement>(null);
  usePageEnter(pageRef, 'grader');

  const [rooms, setRooms] = useState<GraderRoomItem[]>([]);
  const [roomCode, setRoomCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPwdModal, setShowPwdModal] = useState(false);

  const loadRooms = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ rooms: GraderRoomItem[] }>('/api/rooms');
      setRooms(data.rooms);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Không thể tải danh sách phòng.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  const handleJoinByCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomCode.trim()) return;
    setNotice(null);
    try {
      await apiFetch('/api/rooms/join-by-code', {
        method: 'POST',
        body: JSON.stringify({ roomCode: roomCode.trim() }),
      });
      setRoomCode('');
      await loadRooms();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Không thể tham gia phòng.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 py-3.5 sm:px-6">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
            Lớp 12A17 · Giám khảo
          </span>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-xs font-medium text-slate-600">
              {user?.fullName}
            </span>
            <button
              type="button"
              onClick={() => setShowPwdModal(true)}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Đổi mật khẩu</span>
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Đăng xuất</span>
            </button>
          </div>
        </div>
      </header>

      <main ref={pageRef} className="mx-auto max-w-6xl px-4 py-6 sm:px-6 space-y-6">
        <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900">
              Phòng thuyết trình được phân công
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Chọn phòng để chấm điểm trực tiếp theo rubric. Phiếu chấm của bạn được lưu độc lập.
            </p>
          </div>

          <form onSubmit={handleJoinByCode} className="flex items-end gap-2">
            <div>
              <label htmlFor="grader-code" className="block text-xs font-medium text-slate-500">
                Tham gia bằng mã phòng
              </label>
              <input
                id="grader-code"
                type="text"
                placeholder="VD: 12A17-GK01"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
                className="mt-1 w-44 rounded-md border border-slate-300 px-3 py-2 font-mono text-sm uppercase placeholder:normal-case"
              />
            </div>
            <button
              type="submit"
              className="min-h-[40px] rounded-md bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Tham gia
            </button>
          </form>
        </section>

        {notice && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {notice}
          </div>
        )}

        {loading ? (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            Đang tải danh sách phòng...
          </div>
        ) : rooms.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            Bạn chưa được phân công vào phòng thuyết trình nào.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {rooms.map((r) => (
              <div key={r.id} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
                <div>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono font-semibold text-indigo-700">{r.room_code}</span>
                    <span>·</span>
                    <span>{r.classroom_name}</span>
                    <span>·</span>
                    <RoomStatusText status={r.status} />
                  </div>
                  <h2 className="mt-1 font-display text-lg font-bold text-slate-900">{r.name}</h2>
                  <div className="mt-1 text-xs text-slate-600 tabular-nums">
                    Ngày {r.session_date} · {r.group_count} nhóm · {r.scored_group_count}/{r.group_count} nhóm đã có phiếu nộp
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                  <Link
                    to={`/score/${r.id}`}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                  >
                    <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
                    <span>Chấm điểm trực tiếp</span>
                  </Link>
                  <Link
                    to={`/results/${r.id}`}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Award className="h-4 w-4" aria-hidden="true" />
                    <span>Xem kết quả</span>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <ChangePasswordModal
        open={showPwdModal || Boolean(user?.mustChangePassword)}
        forced={Boolean(user?.mustChangePassword)}
        onClose={() => setShowPwdModal(false)}
      />
    </div>
  );
}
