import React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Lock,
  RefreshCw,
  WifiOff,
  FileEdit,
} from 'lucide-react';
import {
  ASSESSMENT_STATUS_LABELS,
  ROOM_STATUS_LABELS,
  type AssessmentStatus,
  type RoomStatus,
} from '../lib/domain';

export type SaveSyncState =
  | 'unsaved'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'offline'
  | 'syncing'
  | 'submitted'
  | 'locked';

export function RoomStatusText({ status }: { status: RoomStatus }) {
  const label = ROOM_STATUS_LABELS[status] ?? status;
  const tone =
    status === 'IN_PROGRESS'
      ? 'text-emerald-700'
      : status === 'REGISTRATION_OPEN' || status === 'READY'
      ? 'text-indigo-700'
      : status === 'PAUSED'
      ? 'text-amber-700'
      : status === 'FINALIZED'
      ? 'text-slate-800'
      : 'text-slate-500';

  const Icon =
    status === 'FINALIZED' || status === 'ARCHIVED'
      ? Lock
      : status === 'PAUSED'
      ? Clock
      : CheckCircle2;

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${tone}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function AssessmentStatusText({ status }: { status: AssessmentStatus }) {
  const label = ASSESSMENT_STATUS_LABELS[status] ?? status;
  const tone =
    status === 'SUBMITTED' || status === 'REVIEWED'
      ? 'text-emerald-700'
      : status === 'FINALIZED'
      ? 'text-slate-800'
      : status === 'IN_PROGRESS'
      ? 'text-amber-700'
      : 'text-slate-500';

  const Icon =
    status === 'FINALIZED'
      ? Lock
      : status === 'SUBMITTED' || status === 'REVIEWED'
      ? CheckCircle2
      : FileEdit;

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${tone}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function SaveStateIndicator({
  state,
  savedAt,
  errorMessage,
}: {
  state: SaveSyncState;
  savedAt?: string | null;
  errorMessage?: string | null;
}) {
  const map: Record<
    SaveSyncState,
    { label: string; tone: string; Icon: React.ComponentType<{ className?: string }> }
  > = {
    unsaved: { label: 'Chưa lưu thay đổi', tone: 'text-amber-700', Icon: FileEdit },
    saving: { label: 'Đang lưu nháp...', tone: 'text-indigo-700', Icon: RefreshCw },
    saved: {
      label: savedAt ? `Đã lưu nháp lúc ${savedAt}` : 'Đã lưu nháp lên máy chủ',
      tone: 'text-emerald-700',
      Icon: CheckCircle2,
    },
    failed: {
      label: errorMessage || 'Lưu thất bại — vui lòng thử lại',
      tone: 'text-red-700',
      Icon: AlertCircle,
    },
    offline: {
      label: 'Ngoại tuyến — dữ liệu tạm giữ trên máy',
      tone: 'text-amber-800',
      Icon: WifiOff,
    },
    syncing: { label: 'Đang đồng bộ lại...', tone: 'text-indigo-700', Icon: RefreshCw },
    submitted: { label: 'Đã nộp chính thức', tone: 'text-emerald-800', Icon: CheckCircle2 },
    locked: { label: 'Đã khóa chỉnh sửa', tone: 'text-slate-700', Icon: Lock },
  };

  const cfg = map[state];
  const Icon = cfg.Icon;
  const spin = state === 'saving' || state === 'syncing' ? 'animate-spin' : '';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2 text-xs font-medium ${cfg.tone}`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${spin}`} aria-hidden="true" />
      <span>{cfg.label}</span>
    </div>
  );
}
