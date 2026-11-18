import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GripVertical, Lock, Shuffle, Unlock, UserMinus, UserPlus } from 'lucide-react';
import { apiFetch } from '../../lib/api';

interface GroupMember {
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
  is_locked: number;
  memberCount: number;
  members: GroupMember[];
}

interface UnassignedStudent {
  user_id: string;
  username: string;
  full_name: string | null;
  student_code: string | null;
}

export function GroupManager({ roomId }: { roomId: string }) {
  const [groups, setGroups] = useState<RoomGroup[]>([]);
  const [unassigned, setUnassigned] = useState<UnassignedStudent[]>([]);
  const [roomMeta, setRoomMeta] = useState<{
    name: string;
    allow_student_selection: number;
    require_admin_approval: number;
  } | null>(null);

  const [groupCountInput, setGroupCountInput] = useState(8);
  const [capacityInput, setCapacityInput] = useState(6);
  const [preserveExisting, setPreserveExisting] = useState(true);
  const [assignTargetGroup, setAssignTargetGroup] = useState<Record<string, string>>({});
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', maxCapacity: 6, presentationOrder: 1 });

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [draggingStudent, setDraggingStudent] = useState<{
    userId: string;
    fromGroupId: string | null;
  } | null>(null);
  const draggingRef = useRef<{ userId: string; fromGroupId: string | null } | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    try {
      const data = await apiFetch<{
        room: any;
        groups: RoomGroup[];
        unassignedStudents: UnassignedStudent[];
      }>(`/api/rooms/${roomId}`);
      setRoomMeta(data.room);
      setGroups(data.groups);
      setUnassigned(data.unassignedStudents);
      setGroupCountInput(data.groups.length || 8);
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Lỗi tải dữ liệu nhóm.' });
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleConfigureGroups = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await apiFetch(`/api/rooms/${roomId}/groups/configure`, {
        method: 'POST',
        body: JSON.stringify({
          groupCount: groupCountInput,
          defaultCapacity: capacityInput,
          applyCapacityToAll: true,
        }),
      });
      setNotice({ type: 'success', text: `Đã cập nhật cấu hình ${groupCountInput} nhóm (sức chứa ${capacityInput} HS/nhóm).` });
      await loadData();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Không thể cấu hình nhóm.' });
    } finally {
      setBusy(false);
    }
  };

  const handleAutoDistribute = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await apiFetch<{ assignedTotal: number; unassignedCount: number }>(
        `/api/rooms/${roomId}/groups/auto-distribute`,
        {
          method: 'POST',
          body: JSON.stringify({ preserveExisting }),
        }
      );
      setNotice({
        type: 'success',
        text: `Đã phân chia đều ${res.assignedTotal} học sinh vào ${groups.length} nhóm (chưa xếp: ${res.unassignedCount}).`,
      });
      await loadData();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Phân chia tự động thất bại.' });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleSelectionPolicy = async (field: 'allowStudentSelection' | 'requireAdminApproval', val: boolean) => {
    setBusy(true);
    try {
      await apiFetch(`/api/rooms/${roomId}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: val }),
      });
      await loadData();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Không thể cập nhật chính sách.' });
    } finally {
      setBusy(false);
    }
  };

  const handleAssignStudent = async (userId: string, groupId: string) => {
    if (!groupId) return;
    setBusy(true);
    setNotice(null);
    try {
      await apiFetch(`/api/rooms/${roomId}/groups/${groupId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ userId, reason: 'Giáo viên điều chỉnh thủ công' }),
      });
      await loadData();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Không thể xếp nhóm.' });
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveMember = async (groupId: string, userId: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/rooms/${roomId}/groups/${groupId}/members/${userId}`, {
        method: 'DELETE',
      });
      await loadData();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Không thể gỡ thành viên.' });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleLock = async (g: RoomGroup) => {
    setBusy(true);
    try {
      await apiFetch(`/api/rooms/${roomId}/groups/${g.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isLocked: g.is_locked !== 1 }),
      });
      await loadData();
    } finally {
      setBusy(false);
    }
  };

  const handleSetLeader = async (groupId: string, userId: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/rooms/${roomId}/groups/${groupId}`, {
        method: 'PATCH',
        body: JSON.stringify({ leaderUserId: userId }),
      });
      await loadData();
    } finally {
      setBusy(false);
    }
  };

  const handleSaveGroupMeta = async (groupId: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/rooms/${roomId}/groups/${groupId}`, {
        method: 'PATCH',
        body: JSON.stringify(editForm),
      });
      setEditingGroupId(null);
      await loadData();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Cập nhật nhóm thất bại.' });
    } finally {
      setBusy(false);
    }
  };

  if (!roomId) {
    return <div className="text-sm text-slate-500">Vui lòng chọn một phòng thuyết trình.</div>;
  }

  if (loading) {
    return <div className="text-sm text-slate-500">Đang tải cấu trúc nhóm...</div>;
  }

  return (
    <div className="space-y-6">
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

      {/* Group Configuration & Auto Distribution Engine */}
      <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-slate-900">
              Cấu hình &amp; Chia nhóm thông minh — {roomMeta?.name}
            </h2>
            <p className="text-xs text-slate-600">
              Mặc định 8 nhóm × 6 thành viên cho 48 học sinh. Kéo thả học sinh giữa các nhóm hoặc chọn thủ công để điều chỉnh.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="inline-flex items-center gap-2 font-medium text-slate-700">
              <input
                type="checkbox"
                checked={roomMeta?.allow_student_selection === 1}
                onChange={(e) => void handleToggleSelectionPolicy('allowStudentSelection', e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
              />
              <span>Cho phép HS tự chọn nhóm</span>
            </label>
            <label className="inline-flex items-center gap-2 font-medium text-slate-700">
              <input
                type="checkbox"
                checked={roomMeta?.require_admin_approval === 1}
                onChange={(e) => void handleToggleSelectionPolicy('requireAdminApproval', e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
              />
              <span>Cần giáo viên duyệt vào nhóm</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
          <div>
            <label className="block text-xs font-medium text-slate-600">Số lượng nhóm</label>
            <input
              type="number"
              min={1}
              max={24}
              value={groupCountInput}
              onChange={(e) => setGroupCountInput(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Sức chứa mỗi nhóm</label>
            <input
              type="number"
              min={1}
              max={50}
              value={capacityInput}
              onChange={(e) => setCapacityInput(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums"
            />
          </div>
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleConfigureGroups()}
              className="min-h-[40px] w-full rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
            >
              Áp dụng số nhóm &amp; sức chứa
            </button>
          </div>
          <div className="space-y-1.5">
            <label className="inline-flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={preserveExisting}
                onChange={(e) => setPreserveExisting(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600"
              />
              <span>Giữ lại thành viên đã xếp trước đó</span>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleAutoDistribute()}
              className="inline-flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              <Shuffle className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Chia đều tự động</span>
            </button>
          </div>
        </div>
      </section>

      {/* Unassigned Students Pool (also accepts dropped members from groups) */}
      {(unassigned.length > 0 || draggingStudent?.fromGroupId) && (
        <section
          onDragOver={(e) => {
            const active = draggingRef.current || draggingStudent;
            if (!active?.fromGroupId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDragOverTarget('unassigned');
          }}
          onDragLeave={() => {
            if (dragOverTarget === 'unassigned') setDragOverTarget(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverTarget(null);
            let payload = draggingRef.current || draggingStudent;
            if (!payload) {
              try {
                payload = JSON.parse(e.dataTransfer.getData('text/plain'));
              } catch {
                payload = null;
              }
            }
            draggingRef.current = null;
            setDraggingStudent(null);
            if (payload?.fromGroupId) {
              void handleRemoveMember(payload.fromGroupId, payload.userId);
            }
          }}
          className={`rounded-lg border p-4 space-y-3 transition-colors ${
            dragOverTarget === 'unassigned'
              ? 'border-indigo-500 bg-indigo-50/70 ring-2 ring-indigo-200'
              : 'border-amber-200 bg-amber-50/60'
          }`}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-amber-900">
              Học sinh chưa có nhóm ({unassigned.length})
            </h3>
            <span className="text-xs text-amber-700">
              Kéo vào nhóm bên dưới hoặc chọn từ danh sách
            </span>
          </div>
          {unassigned.length === 0 ? (
            <div className="rounded-md border border-dashed border-amber-300 bg-white/70 px-3 py-3 text-center text-xs text-amber-800">
              Thả học sinh vào đây để đưa về danh sách chưa phân nhóm
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {unassigned.map((s) => (
                <div
                  key={s.user_id}
                  draggable={!busy}
                  onDragStart={(e) => {
                    const data = { userId: s.user_id, fromGroupId: null };
                    draggingRef.current = data;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', JSON.stringify(data));
                    requestAnimationFrame(() => setDraggingStudent(data));
                  }}
                  onDragEnd={() => {
                    draggingRef.current = null;
                    setDraggingStudent(null);
                    setDragOverTarget(null);
                  }}
                  className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-white px-3 py-2 text-xs cursor-grab active:cursor-grabbing"
                >
                  <div className="flex items-center gap-1.5 min-w-0 truncate">
                    <GripVertical className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
                    <span className="font-mono font-semibold text-slate-700">
                      {s.student_code || s.username}
                    </span>
                    <span className="text-slate-900 truncate">{s.full_name}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <select
                      aria-label={`Chọn nhóm cho ${s.username}`}
                      value={assignTargetGroup[s.user_id] ?? ''}
                      onChange={(e) =>
                        setAssignTargetGroup((prev) => ({ ...prev, [s.user_id]: e.target.value }))
                      }
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                    >
                      <option value="">Chọn nhóm...</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name} ({g.memberCount}/{g.max_capacity})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={busy || !assignTargetGroup[s.user_id]}
                      onClick={() => void handleAssignStudent(s.user_id, assignTargetGroup[s.user_id])}
                      aria-label={`Xếp ${s.username} vào nhóm`}
                      className="rounded bg-indigo-600 p-1.5 text-white hover:bg-indigo-700 disabled:opacity-40"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Groups Grid */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {groups.map((g) => {
          const isEditing = editingGroupId === g.id;
          const isDropActive =
            dragOverTarget === g.id && draggingStudent && draggingStudent.fromGroupId !== g.id;
          return (
            <div
              key={g.id}
              onDragOver={(e) => {
                const active = draggingRef.current || draggingStudent;
                if (active && active.fromGroupId === g.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDragOverTarget(g.id);
              }}
              onDragLeave={() => {
                if (dragOverTarget === g.id) setDragOverTarget(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverTarget(null);
                let payload = draggingRef.current || draggingStudent;
                if (!payload) {
                  try {
                    payload = JSON.parse(e.dataTransfer.getData('text/plain'));
                  } catch {
                    payload = null;
                  }
                }
                draggingRef.current = null;
                setDraggingStudent(null);
                if (payload && payload.fromGroupId !== g.id) {
                  void handleAssignStudent(payload.userId, g.id);
                }
              }}
              className={`rounded-lg border p-4 space-y-3 transition-colors ${
                isDropActive
                  ? 'border-indigo-500 bg-indigo-50/40 ring-2 ring-indigo-200'
                  : 'border-slate-200 bg-white'
              }`}
            >
              {isEditing ? (
                <div className="space-y-2.5">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className="text-[11px] text-slate-500">Tên nhóm</label>
                      <input
                        type="text"
                        value={editForm.name}
                        onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                        className="mt-0.5 w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-slate-500">Thứ tự TT</label>
                      <input
                        type="number"
                        min={1}
                        value={editForm.presentationOrder}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, presentationOrder: Number(e.target.value) }))
                        }
                        className="mt-0.5 w-full rounded border border-slate-300 px-2.5 py-1.5 font-mono text-sm"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className="text-[11px] text-slate-500">Chủ đề / Mô tả</label>
                      <input
                        type="text"
                        value={editForm.description}
                        onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                        className="mt-0.5 w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-slate-500">Sức chứa</label>
                      <input
                        type="number"
                        min={1}
                        value={editForm.maxCapacity}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, maxCapacity: Number(e.target.value) }))
                        }
                        className="mt-0.5 w-full rounded border border-slate-300 px-2.5 py-1.5 font-mono text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingGroupId(null)}
                      className="rounded border border-slate-300 px-3 py-1 text-xs"
                    >
                      Hủy
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSaveGroupMeta(g.id)}
                      className="rounded bg-indigo-600 px-3 py-1 text-xs font-semibold text-white"
                    >
                      Lưu
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs text-slate-500">
                      Thứ tự #{g.presentation_order} ·{' '}
                      <span className="font-mono tabular-nums">
                        {g.memberCount}/{g.max_capacity} thành viên
                      </span>
                    </div>
                    <h3 className="font-display text-base font-bold text-slate-900">{g.name}</h3>
                    {g.description && <p className="text-xs text-slate-600">{g.description}</p>}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingGroupId(g.id);
                        setEditForm({
                          name: g.name,
                          description: g.description,
                          maxCapacity: g.max_capacity,
                          presentationOrder: g.presentation_order,
                        });
                      }}
                      className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Sửa
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleToggleLock(g)}
                      aria-label={g.is_locked === 1 ? `Mở khóa ${g.name}` : `Khóa ${g.name}`}
                      className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-xs font-medium ${
                        g.is_locked === 1
                          ? 'border-amber-300 bg-amber-50 text-amber-800'
                          : 'border-slate-300 bg-white text-slate-700'
                      }`}
                    >
                      {g.is_locked === 1 ? (
                        <>
                          <Lock className="h-3 w-3" />
                          <span>Đang khóa</span>
                        </>
                      ) : (
                        <>
                          <Unlock className="h-3 w-3" />
                          <span>Mở</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

              <div className="divide-y divide-slate-100 border-t border-slate-100 pt-2">
                {g.members.length === 0 ? (
                  <div className="py-2 text-xs text-slate-400">Chưa có thành viên.</div>
                ) : (
                  g.members.map((m) => (
                    <div
                      key={m.user_id}
                      draggable={!busy}
                      onDragStart={(e) => {
                        const data = { userId: m.user_id, fromGroupId: g.id };
                        draggingRef.current = data;
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', JSON.stringify(data));
                        requestAnimationFrame(() => setDraggingStudent(data));
                      }}
                      onDragEnd={() => {
                        draggingRef.current = null;
                        setDraggingStudent(null);
                        setDragOverTarget(null);
                      }}
                      className="flex items-center justify-between gap-2 py-1.5 text-xs cursor-grab active:cursor-grabbing hover:bg-slate-50 rounded px-1 -mx-1"
                    >
                      <div className="flex items-center gap-1.5 min-w-0 truncate">
                        <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                        <span className="font-mono text-slate-500">
                          {m.student_code || m.username}
                        </span>
                        <span className="font-medium text-slate-800 truncate">
                          {m.full_name || m.username}
                        </span>
                        {g.leader_user_id === m.user_id && (
                          <span className="ml-1 text-[11px] font-semibold text-indigo-700 shrink-0">
                            Trưởng nhóm
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {g.leader_user_id !== m.user_id && (
                          <button
                            type="button"
                            onClick={() => void handleSetLeader(g.id, m.user_id)}
                            className="text-[11px] text-slate-500 hover:text-indigo-700"
                          >
                            Đặt nhóm trưởng
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleRemoveMember(g.id, m.user_id)}
                          aria-label={`Gỡ ${m.username} khỏi ${g.name}`}
                          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <UserMinus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
