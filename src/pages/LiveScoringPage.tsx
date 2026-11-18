import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  History,
  Lock,
  Save,
  Send,
  Users,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useRoomRealtime } from '../hooks/useRoomRealtime';
import { apiFetch, formatViDateTime } from '../lib/api';
import {
  computeMaxPossibleScore,
  validateAndCalculateTotal,
  type AssessmentStatus,
  type RoomStatus,
  type RubricCriterionDef,
  type ScoringMode,
} from '../lib/domain';
import { animateSaveConfirmation, usePageEnter } from '../lib/gsap';
import { AssessmentStatusText, RoomStatusText, SaveStateIndicator, type SaveSyncState } from '../components/StatusText';
import { ConfirmModal } from '../components/ConfirmModal';

interface GroupMember {
  user_id: string;
  username: string;
  full_name: string | null;
  student_code: string | null;
}

interface RoomGroup {
  id: string;
  name: string;
  description: string;
  max_capacity: number;
  presentation_order: number;
  memberCount: number;
  members: GroupMember[];
}

interface CriterionItem extends RubricCriterionDef {
  description: string;
}

interface AssessmentRecord {
  id: string;
  room_id: string;
  group_id: string;
  grader_id: string;
  grader_name: string;
  grader_username: string;
  status: AssessmentStatus;
  total_score: number;
  version: number;
  submitted_at: string | null;
  updated_at: string;
  scores: Array<{ criterion_id: string; score: number; comment: string }>;
  comments: {
    overall_comment: string;
    strengths: string;
    weaknesses: string;
    suggestions: string;
    public_feedback: string;
    private_notes: string;
  } | null;
  revisions: Array<{
    id: string;
    revision_number: number;
    changed_by_name: string;
    previous_total_score: number | null;
    new_total_score: number;
    reason: string;
    created_at: string;
  }>;
}

interface FeedbackDraft {
  overallComment: string;
  strengths: string;
  weaknesses: string;
  suggestions: string;
  publicFeedback: string;
  privateNotes: string;
}

const EMPTY_FEEDBACK: FeedbackDraft = {
  overallComment: '',
  strengths: '',
  weaknesses: '',
  suggestions: '',
  publicFeedback: '',
  privateNotes: '',
};

export function LiveScoringPage({ embeddedRoomId }: { embeddedRoomId?: string }) {
  const params = useParams<{ roomId: string }>();
  const roomId = embeddedRoomId || params.roomId || '';
  const navigate = useNavigate();
  const { user } = useAuth();

  const pageRef = useRef<HTMLDivElement>(null);
  const saveBadgeRef = useRef<HTMLDivElement>(null);
  usePageEnter(pageRef, roomId);

  const [room, setRoom] = useState<{
    id: string;
    name: string;
    room_code: string;
    classroom_name: string;
    status: RoomStatus;
    multi_grader_policy: string;
  } | null>(null);
  const [groups, setGroups] = useState<RoomGroup[]>([]);
  const [rubric, setRubric] = useState<{
    id: string;
    title: string;
    scoring_mode: ScoringMode;
    decimal_precision: 0 | 1 | 2;
    max_total_score: number;
  } | null>(null);
  const [criteria, setCriteria] = useState<CriterionItem[]>([]);
  const [assessments, setAssessments] = useState<AssessmentRecord[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>('');

  // Editable draft form state for the active group
  const [scoresMap, setScoresMap] = useState<Record<string, string>>({});
  const [criterionComments, setCriterionComments] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<FeedbackDraft>(EMPTY_FEEDBACK);
  const [version, setVersion] = useState<number | undefined>(undefined);

  const [saveState, setSaveState] = useState<SaveSyncState>('saved');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);

  const [correctionMode, setCorrectionMode] = useState(false);
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionBusy, setCorrectionBusy] = useState(false);

  const dirtyRef = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);
  const pendingIdempotencyRef = useRef<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    if (!roomId) return;
    const [roomData, asmtData] = await Promise.all([
      apiFetch<{
        room: any;
        groups: RoomGroup[];
        rubric: any;
        criteria: CriterionItem[];
      }>(`/api/rooms/${roomId}`),
      apiFetch<{ assessments: AssessmentRecord[] }>(`/api/rooms/${roomId}/assessments`),
    ]);
    setRoom(roomData.room);
    setGroups(roomData.groups);
    setRubric(roomData.rubric);
    setCriteria(
      roomData.criteria.map((c: any) => ({
        id: c.id,
        name: c.name,
        description: c.description || '',
        minScore: c.min_score ?? c.minScore ?? 0,
        maxScore: c.max_score ?? c.maxScore ?? 10,
        weight: c.weight ?? 1,
        sortOrder: c.sort_order ?? c.sortOrder ?? 1,
      }))
    );
    setAssessments(asmtData.assessments);
    setActiveGroupId((prev) => {
      if (prev && roomData.groups.some((g) => g.id === prev)) return prev;
      return roomData.groups[0]?.id ?? '';
    });
  }, [roomId]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    loadWorkspace()
      .catch((err) => {
        if (mounted) setErrorMsg(err instanceof Error ? err.message : 'Không thể tải phiên chấm điểm.');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [loadWorkspace]);

  const handleRealtime = useCallback(
    (eventType: string) => {
      if (eventType === 'room:updated' || eventType === 'group:updated' || eventType === 'assessment:updated' || eventType === 'reconnected') {
        void loadWorkspace();
      }
    },
    [loadWorkspace]
  );

  useRoomRealtime(roomId, handleRealtime);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? null,
    [groups, activeGroupId]
  );

  const myAssessment = useMemo(
    () =>
      assessments.find((a) => a.group_id === activeGroupId && a.grader_id === user?.id) ?? null,
    [assessments, activeGroupId, user?.id]
  );

  const otherGradersAssessments = useMemo(
    () =>
      assessments.filter((a) => a.group_id === activeGroupId && a.grader_id !== user?.id),
    [assessments, activeGroupId, user?.id]
  );

  // Hydrate form when active group or server assessment changes (only when not actively dirty)
  useEffect(() => {
    if (!activeGroupId) return;
    if (dirtyRef.current) return;

    const backupKey = `c48_draft_${roomId}_${activeGroupId}_${user?.id}`;
    const rawBackup = sessionStorage.getItem(backupKey);

    if (myAssessment) {
      const nextScores: Record<string, string> = {};
      const nextCritComments: Record<string, string> = {};
      for (const s of myAssessment.scores) {
        nextScores[s.criterion_id] = String(s.score);
        nextCritComments[s.criterion_id] = s.comment || '';
      }
      setScoresMap(nextScores);
      setCriterionComments(nextCritComments);
      setFeedback({
        overallComment: myAssessment.comments?.overall_comment ?? '',
        strengths: myAssessment.comments?.strengths ?? '',
        weaknesses: myAssessment.comments?.weaknesses ?? '',
        suggestions: myAssessment.comments?.suggestions ?? '',
        publicFeedback: myAssessment.comments?.public_feedback ?? '',
        privateNotes: myAssessment.comments?.private_notes ?? '',
      });
      setVersion(myAssessment.version);
      if (myAssessment.status === 'FINALIZED') setSaveState('locked');
      else if (myAssessment.status === 'SUBMITTED' || myAssessment.status === 'REVIEWED')
        setSaveState('submitted');
      else setSaveState('saved');
    } else if (rawBackup) {
      try {
        const parsed = JSON.parse(rawBackup) as {
          scoresMap: Record<string, string>;
          criterionComments: Record<string, string>;
          feedback: FeedbackDraft;
        };
        setScoresMap(parsed.scoresMap ?? {});
        setCriterionComments(parsed.criterionComments ?? {});
        setFeedback(parsed.feedback ?? EMPTY_FEEDBACK);
        setVersion(undefined);
        setSaveState('unsaved');
      } catch {
        setScoresMap({});
        setCriterionComments({});
        setFeedback(EMPTY_FEEDBACK);
        setVersion(undefined);
      }
    } else {
      setScoresMap({});
      setCriterionComments({});
      setFeedback(EMPTY_FEEDBACK);
      setVersion(undefined);
      setSaveState('saved');
    }
    setCorrectionMode(false);
    setCorrectionReason('');
    pendingIdempotencyRef.current = null;
  }, [activeGroupId, myAssessment, roomId, user?.id]);

  const isLockedOrSubmitted =
    myAssessment?.status === 'SUBMITTED' ||
    myAssessment?.status === 'REVIEWED' ||
    myAssessment?.status === 'FINALIZED' ||
    room?.status === 'FINALIZED' ||
    room?.status === 'ARCHIVED';

  const canEditFields = !isLockedOrSubmitted || correctionMode;

  const liveCalc = useMemo(() => {
    if (!rubric || criteria.length === 0) {
      return { valid: false, totalScore: 0, errors: [] as string[] };
    }
    const inputs = Object.entries(scoresMap)
      .filter(([, val]) => val.trim() !== '')
      .map(([criterionId, val]) => ({
        criterionId,
        score: Number(val),
      }));

    return validateAndCalculateTotal(criteria, inputs, {
      scoringMode: rubric.scoring_mode,
      decimalPrecision: rubric.decimal_precision,
      requireAllCriteria: false,
    });
  }, [criteria, rubric, scoresMap]);

  const maxPossible = useMemo(() => {
    if (!rubric) return 10;
    return computeMaxPossibleScore(criteria, rubric.scoring_mode, rubric.decimal_precision);
  }, [criteria, rubric]);

  const buildPayload = useCallback(() => {
    const scores = Object.entries(scoresMap)
      .filter(([, val]) => val.trim() !== '')
      .map(([criterionId, val]) => ({
        criterionId,
        score: Number(val),
        comment: criterionComments[criterionId] || '',
      }));

    return {
      scores,
      comments: feedback,
      version,
    };
  }, [scoresMap, criterionComments, feedback, version]);

  const saveDraftNow = useCallback(async (): Promise<boolean> => {
    if (!roomId || !activeGroupId || isLockedOrSubmitted) return true;
    if (!navigator.onLine) {
      setSaveState('offline');
      return false;
    }

    setSaveState('saving');
    setErrorMsg(null);
    const payload = buildPayload();

    try {
      const res = await apiFetch<{
        assessment: { id: string; totalScore: number; version: number; savedAt: string };
      }>(`/api/rooms/${roomId}/groups/${activeGroupId}/assessment`, {
        method: 'PUT',
        retries: 1,
        body: JSON.stringify(payload),
      });

      dirtyRef.current = false;
      setVersion(res.assessment.version);
      sessionStorage.removeItem(`c48_draft_${roomId}_${activeGroupId}_${user?.id}`);
      const timeStr = new Intl.DateTimeFormat('vi-VN', { timeStyle: 'medium' }).format(
        new Date(res.assessment.savedAt)
      );
      setLastSavedAt(timeStr);
      setSaveState('saved');
      animateSaveConfirmation(saveBadgeRef.current);
      await loadWorkspace();
      return true;
    } catch (err) {
      setSaveState('failed');
      setErrorMsg(err instanceof Error ? err.message : 'Lưu nháp thất bại.');
      return false;
    }
  }, [roomId, activeGroupId, isLockedOrSubmitted, buildPayload, user?.id, loadWorkspace]);

  // Debounced autosave + crash-recovery sessionStorage backup
  const scheduleAutosave = useCallback(
    (
      nextScores: Record<string, string>,
      nextCritComments: Record<string, string>,
      nextFeedback: FeedbackDraft
    ) => {
      if (isLockedOrSubmitted) return;
      dirtyRef.current = true;
      setSaveState(navigator.onLine ? 'unsaved' : 'offline');
      sessionStorage.setItem(
        `c48_draft_${roomId}_${activeGroupId}_${user?.id}`,
        JSON.stringify({
          scoresMap: nextScores,
          criterionComments: nextCritComments,
          feedback: nextFeedback,
        })
      );

      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = window.setTimeout(() => {
        void saveDraftNow();
      }, 900);
    },
    [isLockedOrSubmitted, roomId, activeGroupId, user?.id, saveDraftNow]
  );

  // Sync automatically when coming back online
  useEffect(() => {
    const onOnline = () => {
      if (dirtyRef.current) {
        setSaveState('syncing');
        void saveDraftNow();
      }
    };
    const onOffline = () => {
      if (dirtyRef.current) setSaveState('offline');
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [saveDraftNow]);

  const handleSelectGroup = async (nextGroupId: string) => {
    if (nextGroupId === activeGroupId) return;
    if (dirtyRef.current && !isLockedOrSubmitted) {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      await saveDraftNow();
    }
    dirtyRef.current = false;
    setActiveGroupId(nextGroupId);
  };

  const updateScore = (criterionId: string, value: string) => {
    const next = { ...scoresMap, [criterionId]: value };
    setScoresMap(next);
    scheduleAutosave(next, criterionComments, feedback);
  };

  const nudgeScore = (c: CriterionItem, delta: number | 'max') => {
    if (!canEditFields) return;
    const precision = rubric?.decimal_precision ?? 2;
    const step = precision === 0 ? 1 : precision === 2 ? 0.25 : 0.5;
    const actualDelta = delta === 'max' ? 0 : delta;
    const current = Number(scoresMap[c.id] || 0);
    const nextVal =
      delta === 'max'
        ? c.maxScore
        : Number(
            Math.min(
              c.maxScore,
              Math.max(c.minScore, Math.round((current + actualDelta) / step) * step)
            ).toFixed(precision)
          );
    updateScore(c.id, String(nextVal));
  };

  const updateFeedbackField = (field: keyof FeedbackDraft, value: string) => {
    const next = { ...feedback, [field]: value };
    setFeedback(next);
    scheduleAutosave(scoresMap, criterionComments, next);
  };

  const handleOpenSubmitConfirm = () => {
    setErrorMsg(null);
    const allInputs = criteria.map((c) => ({
      criterionId: c.id,
      score: scoresMap[c.id] === undefined || scoresMap[c.id].trim() === '' ? NaN : Number(scoresMap[c.id]),
    }));
    const validation = validateAndCalculateTotal(criteria, allInputs, {
      scoringMode: rubric?.scoring_mode ?? 'SUM',
      decimalPrecision: rubric?.decimal_precision ?? 1,
      requireAllCriteria: true,
    });
    if (!validation.valid) {
      setErrorMsg(validation.errors[0]);
      return;
    }
    if (!pendingIdempotencyRef.current) {
      pendingIdempotencyRef.current = crypto.randomUUID();
    }
    setShowSubmitConfirm(true);
  };

  const handleSubmitOfficial = async () => {
    if (!roomId || !activeGroupId) return;
    setSubmitBusy(true);
    setErrorMsg(null);
    try {
      const scores = criteria.map((c) => ({
        criterionId: c.id,
        score: Number(scoresMap[c.id]),
        comment: criterionComments[c.id] || '',
      }));

      await apiFetch(`/api/rooms/${roomId}/groups/${activeGroupId}/assessment/submit`, {
        method: 'POST',
        retries: 2,
        body: JSON.stringify({
          idempotencyKey: pendingIdempotencyRef.current,
          scores,
          comments: feedback,
        }),
      });

      dirtyRef.current = false;
      pendingIdempotencyRef.current = null;
      sessionStorage.removeItem(`c48_draft_${roomId}_${activeGroupId}_${user?.id}`);
      setShowSubmitConfirm(false);
      setSaveState('submitted');
      await loadWorkspace();
    } catch (err) {
      setShowSubmitConfirm(false);
      setSaveState('failed');
      setErrorMsg(err instanceof Error ? err.message : 'Không thể nộp phiếu chấm.');
    } finally {
      setSubmitBusy(false);
    }
  };

  const handleSubmitCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!myAssessment) return;
    setErrorMsg(null);

    if (correctionReason.trim().length < 4) {
      setErrorMsg('Vui lòng ghi rõ lý do hiệu chỉnh điểm (tối thiểu 4 ký tự).');
      return;
    }

    const scores = criteria.map((c) => ({
      criterionId: c.id,
      score: Number(scoresMap[c.id]),
      comment: criterionComments[c.id] || '',
    }));

    setCorrectionBusy(true);
    try {
      await apiFetch(`/api/rooms/${roomId}/assessments/${myAssessment.id}/correct`, {
        method: 'POST',
        body: JSON.stringify({
          reason: correctionReason.trim(),
          scores,
          comments: feedback,
        }),
      });
      setCorrectionMode(false);
      setCorrectionReason('');
      dirtyRef.current = false;
      await loadWorkspace();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Hiệu chỉnh điểm thất bại.');
    } finally {
      setCorrectionBusy(false);
    }
  };

  const activeIdx = groups.findIndex((g) => g.id === activeGroupId);
  const nextGroup = activeIdx >= 0 && activeIdx < groups.length - 1 ? groups[activeIdx + 1] : null;
  const prevGroup = activeIdx > 0 ? groups[activeIdx - 1] : null;

  if (loading) {
    return (
      <div className="p-8 text-center text-sm text-slate-500">
        Đang tải không gian chấm điểm trực tiếp...
      </div>
    );
  }

  if (!room) {
    return (
      <div className="p-8 text-center text-sm text-red-600">
        {errorMsg || 'Không tìm thấy phòng thuyết trình.'}
      </div>
    );
  }

  return (
    <div ref={pageRef} className="min-h-screen bg-slate-50 pb-24 lg:pb-10">
      {/* Contextual Top Header */}
      {!embeddedRoomId && (
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-2.5 px-4 py-3 sm:gap-4 sm:py-3.5 sm:px-6">
            <div className="flex flex-1 items-center gap-2.5 sm:gap-3 min-w-0">
              <button
                type="button"
                onClick={() => navigate(user?.role === 'GRADER' ? '/grader' : '/admin')}
                aria-label="Quay lại"
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 sm:px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Quay lại</span>
              </button>
              <div className="min-w-0 flex-1 overflow-hidden">
                <div className="truncate font-display text-sm sm:text-base font-bold text-slate-900">
                  {room.name}
                </div>
                <div className="flex items-center gap-1.5 truncate text-xs text-slate-500">
                  <span className="font-mono whitespace-nowrap shrink-0">{room.room_code}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">
                    <RoomStatusText status={room.status} />
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <Link
                to={`/results/${roomId}`}
                className="inline-flex min-h-[38px] items-center rounded-md border border-slate-300 bg-white px-2.5 sm:px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <span className="sm:hidden">Bảng điểm</span>
                <span className="hidden sm:inline">Xem bảng xếp hạng</span>
              </Link>
            </div>
          </div>
        </header>
      )}

      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left Group Queue */}
          <aside className="lg:col-span-4 xl:col-span-3 space-y-3">
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-xs font-semibold text-slate-700">
                  Danh sách nhóm ({groups.length})
                </h2>
                <span className="font-mono text-xs tabular-nums text-slate-500">
                  {assessments.filter((a) => a.grader_id === user?.id && a.status !== 'DRAFT' && a.status !== 'IN_PROGRESS').length}/{groups.length} đã nộp
                </span>
              </div>

              <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
                {groups.map((g) => {
                  const mine = assessments.find(
                    (a) => a.group_id === g.id && a.grader_id === user?.id
                  );
                  const isActive = g.id === activeGroupId;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => void handleSelectGroup(g.id)}
                      className={`min-w-[160px] lg:min-w-0 shrink-0 rounded-md border p-3 text-left transition-colors ${
                        isActive
                          ? 'border-indigo-600 bg-indigo-50/70'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-mono text-slate-500">
                          #{g.presentation_order}
                        </span>
                        <span className="font-mono text-xs font-semibold tabular-nums text-slate-900">
                          {mine ? `${mine.total_score}/${maxPossible}` : '—'}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-sm font-semibold text-slate-900">
                        {g.name}
                      </div>
                      <div className="mt-1 flex items-center justify-between text-xs">
                        <span className="text-slate-500">{g.memberCount} thành viên</span>
                        {mine ? (
                          <AssessmentStatusText status={mine.status} />
                        ) : (
                          <span className="text-slate-400">Chưa chấm</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          {/* Main Scoring Area */}
          <section className="lg:col-span-8 xl:col-span-9 space-y-5">
            {activeGroup && (
              <>
                {/* Active Group Identity Banner (prevents scoring wrong group) */}
                <div className="rounded-lg border border-slate-200 bg-white p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="text-xs font-medium text-indigo-700">
                        Đang chấm điểm · Thứ tự #{activeGroup.presentation_order} · {room.room_code}
                      </div>
                      <h1 className="mt-1 font-display text-2xl font-bold text-slate-900">
                        {activeGroup.name}
                        {activeGroup.description ? ` — ${activeGroup.description}` : ''}
                      </h1>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                        <span className="inline-flex items-center gap-1 font-medium text-slate-700">
                          <Users className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Thành viên ({activeGroup.members.length}):</span>
                        </span>
                        {activeGroup.members.map((m) => (
                          <span key={m.user_id}>
                            <span className="font-mono text-slate-500">{m.student_code || m.username}</span>{' '}
                            {m.full_name || m.username}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="shrink-0 text-left sm:text-right">
                      <div className="text-xs text-slate-500">Tổng điểm hiện tại</div>
                      <div className="font-display text-3xl font-bold tabular-nums text-slate-900">
                        {liveCalc.totalScore}
                        <span className="text-base font-normal text-slate-400"> / {maxPossible}</span>
                      </div>
                      <div ref={saveBadgeRef} className="mt-1">
                        <SaveStateIndicator
                          state={saveState}
                          savedAt={lastSavedAt}
                          errorMessage={errorMsg}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {errorMsg && (
                  <div
                    role="alert"
                    className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                  >
                    {errorMsg}
                  </div>
                )}

                {room.status !== 'IN_PROGRESS' && room.status !== 'PAUSED' && room.status !== 'READY' && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    Phòng hiện đang ở trạng thái <strong>{room.status}</strong>. Bạn có thể chuẩn bị bản nháp, nhưng cần chuyển phòng sang &ldquo;Đang chấm điểm&rdquo; để nộp phiếu chính thức.
                  </div>
                )}

                {/* Criteria Inputs */}
                <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-200">
                  <div className="flex items-center justify-between px-5 py-3.5 bg-slate-50 rounded-t-lg">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-900">
                        {rubric?.title || 'Tiêu chí chấm điểm'}
                      </h2>
                      <p className="text-xs text-slate-500">
                        Chế độ: {rubric?.scoring_mode === 'WEIGHTED' ? 'Tính theo trọng số' : 'Cộng tổng trực tiếp'} · Độ chính xác {rubric?.decimal_precision ?? 1} chữ số thập phân
                      </p>
                    </div>
                    {isLockedOrSubmitted && !correctionMode && room.status !== 'FINALIZED' && (
                      <button
                        type="button"
                        onClick={() => setCorrectionMode(true)}
                        className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-amber-600 bg-white px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-50 whitespace-nowrap"
                      >
                        <History className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Hiệu chỉnh điểm</span>
                      </button>
                    )}
                  </div>

                  {criteria.map((c, idx) => {
                    const rawVal = scoresMap[c.id] ?? '';
                    const numVal = Number(rawVal);
                    const outOfRange =
                      rawVal.trim() !== '' &&
                      (Number.isNaN(numVal) || numVal < c.minScore || numVal > c.maxScore);

                    return (
                      <div key={c.id} className="p-4 sm:p-5 space-y-3">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex-1">
                            <label
                              htmlFor={`score-input-${c.id}`}
                              className="text-sm font-semibold text-slate-900"
                            >
                              {idx + 1}. {c.name}
                            </label>
                            {c.description && (
                              <p className="mt-0.5 text-xs text-slate-500">{c.description}</p>
                            )}
                            <div className="mt-1 text-xs text-slate-500">
                              Khoảng điểm: <span className="font-mono tabular-nums">{c.minScore} – {c.maxScore}</span>
                              {rubric?.scoring_mode === 'WEIGHTED' && (
                                <>
                                  {' · '}Trọng số: <span className="font-mono tabular-nums">{c.weight}</span>
                                </>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <div className="hidden sm:flex items-center gap-1">
                              <button
                                type="button"
                                disabled={!canEditFields}
                                onClick={() => nudgeScore(c, rubric?.decimal_precision === 0 ? -1 : -0.5)}
                                className="min-h-[40px] min-w-[42px] rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-mono font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                              >
                                {rubric?.decimal_precision === 0 ? '-1' : '-0.5'}
                              </button>
                              {rubric?.decimal_precision !== 0 && (
                                <button
                                  type="button"
                                  disabled={!canEditFields}
                                  onClick={() => nudgeScore(c, 0.25)}
                                  className="min-h-[40px] min-w-[46px] rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-mono font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                                >
                                  +0.25
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={!canEditFields}
                                onClick={() => nudgeScore(c, rubric?.decimal_precision === 0 ? 1 : 0.5)}
                                className="min-h-[40px] min-w-[44px] rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-mono font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                              >
                                {rubric?.decimal_precision === 0 ? '+1' : '+0.5'}
                              </button>
                              <button
                                type="button"
                                disabled={!canEditFields}
                                onClick={() => nudgeScore(c, 'max')}
                                className="min-h-[40px] rounded-md border border-slate-200 bg-slate-50 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                              >
                                Tối đa
                              </button>
                            </div>

                            <div className="flex items-center gap-1.5">
                              <input
                                id={`score-input-${c.id}`}
                                type="number"
                                inputMode="decimal"
                                min={c.minScore}
                                max={c.maxScore}
                                step={rubric?.decimal_precision === 0 ? 1 : rubric?.decimal_precision === 2 ? 0.25 : 0.5}
                                disabled={!canEditFields}
                                value={rawVal}
                                onChange={(e) => updateScore(c.id, e.target.value)}
                                placeholder="0"
                                className={`min-h-[44px] w-24 rounded-md border px-3 py-2 text-right font-mono text-base font-semibold tabular-nums focus:outline-none focus:ring-2 ${
                                  outOfRange
                                    ? 'border-red-500 bg-red-50 text-red-700 focus:ring-red-500/20'
                                    : 'border-slate-300 bg-white text-slate-900 focus:border-indigo-600 focus:ring-indigo-600/20'
                                } disabled:bg-slate-100 disabled:text-slate-600`}
                              />
                              <span className="font-mono text-xs text-slate-400 tabular-nums">
                                /{c.maxScore}
                              </span>
                            </div>
                          </div>
                        </div>

                        {outOfRange && (
                          <div className="text-xs font-medium text-red-600">
                            Điểm phải nằm trong khoảng {c.minScore} đến {c.maxScore}.
                          </div>
                        )}

                        <input
                          type="text"
                          disabled={!canEditFields}
                          aria-label={`Ghi chú tiêu chí ${c.name}`}
                          placeholder="Ghi chú ngắn cho tiêu chí này (tùy chọn)..."
                          value={criterionComments[c.id] ?? ''}
                          onChange={(e) => {
                            const next = { ...criterionComments, [c.id]: e.target.value };
                            setCriterionComments(next);
                            scheduleAutosave(scoresMap, next, feedback);
                          }}
                          className="w-full rounded-md border border-slate-200 bg-slate-50/70 px-3 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:border-indigo-600 focus:bg-white focus:outline-none disabled:opacity-60"
                        />
                      </div>
                    );
                  })}
                </div>

                {/* Structured Feedback & Private Teacher Notes */}
                <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
                  <h2 className="text-base font-semibold text-slate-900">
                    Nhận xét &amp; Phản hồi cho {activeGroup.name}
                  </h2>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label htmlFor="fb-strengths" className="block text-xs font-semibold text-emerald-800">
                        Điểm mạnh
                      </label>
                      <textarea
                        id="fb-strengths"
                        rows={2}
                        disabled={!canEditFields}
                        value={feedback.strengths}
                        onChange={(e) => updateFeedbackField('strengths', e.target.value)}
                        placeholder="Nội dung chuẩn bị tốt, phối hợp ăn ý..."
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-600 focus:outline-none disabled:bg-slate-50"
                      />
                    </div>
                    <div>
                      <label htmlFor="fb-weaknesses" className="block text-xs font-semibold text-amber-800">
                        Điểm cần khắc phục
                      </label>
                      <textarea
                        id="fb-weaknesses"
                        rows={2}
                        disabled={!canEditFields}
                        value={feedback.weaknesses}
                        onChange={(e) => updateFeedbackField('weaknesses', e.target.value)}
                        placeholder="Slide hơi nhiều chữ, cần kiểm soát thời gian..."
                        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-600 focus:outline-none disabled:bg-slate-50"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="fb-suggestions" className="block text-xs font-semibold text-slate-700">
                      Đề xuất cải thiện
                    </label>
                    <textarea
                      id="fb-suggestions"
                      rows={2}
                      disabled={!canEditFields}
                      value={feedback.suggestions}
                      onChange={(e) => updateFeedbackField('suggestions', e.target.value)}
                      placeholder="Gợi ý hướng phát triển hoặc bổ sung số liệu minh họa..."
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-600 focus:outline-none disabled:bg-slate-50"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label htmlFor="fb-public" className="block text-xs font-semibold text-indigo-800">
                        Nhận xét công khai (Hiển thị cho học sinh)
                      </label>
                      <textarea
                        id="fb-public"
                        rows={3}
                        disabled={!canEditFields}
                        value={feedback.publicFeedback}
                        onChange={(e) => updateFeedbackField('publicFeedback', e.target.value)}
                        placeholder="Nhận xét chính thức sẽ hiển thị cho sinh viên khi công bố..."
                        className="mt-1 w-full rounded-md border border-indigo-200 px-3 py-2 text-sm focus:border-indigo-600 focus:outline-none disabled:bg-slate-50"
                      />
                    </div>

                    <div>
                      <label htmlFor="fb-private" className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                        <Lock className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                        <span>Ghi chú nội bộ giáo viên (Không gửi tới học sinh)</span>
                      </label>
                      <textarea
                        id="fb-private"
                        rows={3}
                        disabled={!canEditFields}
                        value={feedback.privateNotes}
                        onChange={(e) => updateFeedbackField('privateNotes', e.target.value)}
                        placeholder="Ghi chú riêng cho hội đồng chấm thi hoặc lưu hồ sơ..."
                        className="mt-1 w-full rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm focus:border-indigo-600 focus:bg-white focus:outline-none"
                      />
                    </div>
                  </div>
                </div>

                {/* Correction form when editing after submission */}
                {correctionMode && (
                  <form
                    onSubmit={handleSubmitCorrection}
                    className="rounded-lg border border-amber-300 bg-amber-50 p-5 space-y-3"
                  >
                    <h3 className="text-sm font-semibold text-amber-900">
                      Ghi nhận hiệu chỉnh điểm (Tạo phiên bản lịch sử mới)
                    </h3>
                    <div>
                      <label htmlFor="corr-reason" className="block text-xs font-medium text-amber-900">
                        Lý do hiệu chỉnh điểm (bắt buộc)
                      </label>
                      <input
                        id="corr-reason"
                        type="text"
                        required
                        minLength={4}
                        value={correctionReason}
                        onChange={(e) => setCorrectionReason(e.target.value)}
                        placeholder="Ví dụ: Cộng bổ sung 1 điểm phần trả lời phản biện theo biên bản lớp"
                        className="mt-1 w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none"
                      />
                    </div>
                    <div className="flex items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setCorrectionMode(false);
                          dirtyRef.current = false;
                          void loadWorkspace();
                        }}
                        className="min-h-[40px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
                      >
                        Hủy hiệu chỉnh
                      </button>
                      <button
                        type="submit"
                        disabled={correctionBusy}
                        className="min-h-[40px] rounded-md bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
                      >
                        {correctionBusy ? 'Đang lưu...' : 'Lưu hiệu chỉnh & Ghi nhật ký'}
                      </button>
                    </div>
                  </form>
                )}

                {/* Action Footer (Desktop + Mobile Sticky Bar) */}
                {!correctionMode && (
                  <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white px-4 py-2.5 lg:static lg:rounded-lg lg:border lg:p-4">
                    <div className="mx-auto max-w-7xl space-y-1.5 lg:space-y-0">
                      <div className="flex items-center justify-between text-xs text-slate-600 lg:hidden">
                        <span className="font-semibold text-slate-900 truncate">
                          {activeGroup.name} (#{activeGroup.presentation_order})
                        </span>
                        <span className="font-mono font-bold tabular-nums text-indigo-700 shrink-0">
                          {liveCalc.totalScore} / {maxPossible}
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={!prevGroup}
                            onClick={() => prevGroup && void handleSelectGroup(prevGroup.id)}
                            className="inline-flex min-h-[40px] items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
                          >
                            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="hidden sm:inline">Nhóm trước</span>
                          </button>
                          <button
                            type="button"
                            disabled={!nextGroup}
                            onClick={() => nextGroup && void handleSelectGroup(nextGroup.id)}
                            className="inline-flex min-h-[40px] items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
                          >
                            <span className="hidden sm:inline">Nhóm tiếp</span>
                            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>

                        <div className="hidden lg:flex items-center gap-2 text-xs text-slate-600">
                          <span className="font-semibold text-slate-900">{activeGroup.name}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono font-bold tabular-nums text-indigo-700">
                            {liveCalc.totalScore}/{maxPossible} điểm
                          </span>
                        </div>

                        {!isLockedOrSubmitted ? (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void saveDraftNow()}
                              className="inline-flex min-h-[42px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
                            >
                              <Save className="h-4 w-4" aria-hidden="true" />
                              <span>Lưu nháp</span>
                            </button>
                            <button
                              type="button"
                              onClick={handleOpenSubmitConfirm}
                              className="inline-flex min-h-[42px] items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white hover:bg-indigo-700 whitespace-nowrap"
                            >
                              <Send className="h-4 w-4" aria-hidden="true" />
                              <span>Nộp phiếu chấm</span>
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                            <span>Đã nộp {formatViDateTime(myAssessment?.submitted_at)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Other Graders' Independent Assessments (visible to Teachers/Admins) */}
                {otherGradersAssessments.length > 0 && (
                  <div className="rounded-lg border border-slate-200 bg-white p-5">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <ClipboardCheck className="h-4 w-4 text-indigo-600" aria-hidden="true" />
                      <span>Phiếu chấm độc lập của giám khảo khác ({otherGradersAssessments.length})</span>
                    </h3>
                    <div className="mt-3 divide-y divide-slate-100">
                      {otherGradersAssessments.map((oa) => (
                        <div key={oa.id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="text-sm font-medium text-slate-800">
                              {oa.grader_name} ({oa.grader_username})
                            </div>
                            {oa.comments?.public_feedback && (
                              <div className="text-xs text-slate-600">{oa.comments.public_feedback}</div>
                            )}
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <AssessmentStatusText status={oa.status} />
                            <span className="font-mono text-sm font-bold tabular-nums text-slate-900">
                              {oa.total_score}/{maxPossible}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Immutable Revision History */}
                {myAssessment && myAssessment.revisions.length > 0 && (
                  <div className="rounded-lg border border-slate-200 bg-white p-5">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <History className="h-4 w-4 text-slate-600" aria-hidden="true" />
                      <span>Lịch sử phiên bản phiếu chấm</span>
                    </h3>
                    <div className="mt-3 divide-y divide-slate-100">
                      {myAssessment.revisions.map((rev) => (
                        <div key={rev.id} className="py-2.5 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold text-slate-800">
                              Phiên bản #{rev.revision_number} · {rev.changed_by_name}
                            </span>
                            <span className="font-mono tabular-nums text-slate-500">
                              {formatViDateTime(rev.created_at)}
                            </span>
                          </div>
                          <div className="mt-1 text-slate-600">
                            Điểm:{' '}
                            <span className="font-mono tabular-nums">
                              {rev.previous_total_score !== null ? `${rev.previous_total_score} → ` : ''}
                              <strong>{rev.new_total_score}</strong>
                            </span>
                            {' · '}
                            <span>Lý do: {rev.reason}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>

      <ConfirmModal
        open={showSubmitConfirm}
        title={`Xác nhận nộp phiếu chấm cho ${activeGroup?.name ?? ''}`}
        description={`Bạn đang nộp điểm chính thức cho "${activeGroup?.name}" thuộc phòng "${room.name}" (${room.room_code}) với tổng điểm ${liveCalc.totalScore} / ${maxPossible}. Sau khi nộp, mọi chỉnh sửa sẽ được ghi nhận vào lịch sử kiểm toán.`}
        confirmLabel="Xác nhận nộp chính thức"
        busy={submitBusy}
        onConfirm={() => void handleSubmitOfficial()}
        onCancel={() => setShowSubmitConfirm(false)}
      />
    </div>
  );
}
