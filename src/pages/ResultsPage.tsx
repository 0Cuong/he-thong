import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, FileSpreadsheet, FileText, Lock } from 'lucide-react';
import { apiFetch, downloadAuthenticatedFile } from '../lib/api';
import { useRoomRealtime } from '../hooks/useRoomRealtime';
import { usePageEnter, useStaggerReveal } from '../lib/gsap';
import { RoomStatusText } from '../components/StatusText';
import type { GroupResultEntry, RoomStatus, RubricCriterionDef } from '../lib/domain';

interface ResultsData {
  published: boolean;
  room: {
    id: string;
    name: string;
    room_code: string;
    classroom_name: string;
    session_date: string;
    status: RoomStatus;
    multi_grader_policy: string;
    publish_results: number;
  };
  rubric: {
    title: string;
    scoring_mode: string;
    max_total_score: number;
    decimal_precision: number;
  } | null;
  criteria: RubricCriterionDef[];
  summary: {
    totalGroups: number;
    totalStudents: number;
    completedPresentations: number;
    pendingAssessments: number;
    completionPercentage: number;
    averageScore: number | null;
    highestScore: number | null;
    lowestScore: number | null;
  };
  rankings: GroupResultEntry[];
  groupDetails: Array<{
    groupId: string;
    groupName: string;
    members: Array<{ studentCode: string; fullName: string }>;
    graderAssessments: Array<{
      assessmentId: string;
      graderName: string;
      status: string;
      totalScore: number;
      overallComment: string;
      strengths: string;
      weaknesses: string;
      suggestions: string;
      publicFeedback: string;
      privateNotes?: string;
    }>;
  }>;
}

export function ResultsPage({ embeddedRoomId }: { embeddedRoomId?: string }) {
  const params = useParams<{ roomId: string }>();
  const roomId = embeddedRoomId || params.roomId || '';
  const pageRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  usePageEnter(pageRef, roomId);

  const [data, setData] = useState<ResultsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortCriterionId, setSortCriterionId] = useState<string>('TOTAL');

  const loadResults = useCallback(async () => {
    if (!roomId) return;
    const res = await apiFetch<ResultsData>(`/api/rooms/${roomId}/results`);
    setData(res);
  }, [roomId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadResults()
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Không thể tải kết quả.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadResults]);

  useRoomRealtime(roomId, () => {
    void loadResults();
  });

  useStaggerReveal(tableRef, '.ranking-row-item', data?.rankings.length);

  const displayedRankings = useMemo(() => {
    if (!data) return [];
    if (sortCriterionId === 'TOTAL') return data.rankings;
    return [...data.rankings].sort((a, b) => {
      const va = a.criterionAverages[sortCriterionId] ?? -1;
      const vb = b.criterionAverages[sortCriterionId] ?? -1;
      if (vb !== va) return vb - va;
      return a.presentationOrder - b.presentationOrder;
    });
  }, [data, sortCriterionId]);

  if (loading) {
    return (
      <div className="p-8 text-center text-sm text-slate-500">
        Đang tổng hợp bảng điểm và xếp hạng...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8 text-center text-sm text-red-600">
        {error || 'Không có dữ liệu kết quả.'}
      </div>
    );
  }

  const maxScore = data.rubric?.max_total_score ?? 10;

  return (
    <div ref={pageRef} className={embeddedRoomId ? 'space-y-6' : 'min-h-screen bg-slate-50'}>
      {!embeddedRoomId && (
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
            <div className="flex items-center gap-3 min-w-0">
              <Link
                to="/admin"
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Bảng điều khiển</span>
              </Link>
              <div className="min-w-0">
                <h1 className="truncate font-display text-base font-bold text-slate-900">
                  Kết quả &amp; Xếp hạng — {data.room.name}
                </h1>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>{data.room.classroom_name}</span>
                  <span aria-hidden="true">·</span>
                  <RoomStatusText status={data.room.status} />
                </div>
              </div>
            </div>

            <Link
              to={`/score/${roomId}`}
              className="inline-flex min-h-[38px] items-center rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 whitespace-nowrap"
            >
              Chấm điểm trực tiếp
            </Link>
          </div>
        </header>
      )}

      <div className={embeddedRoomId ? 'space-y-6' : 'mx-auto max-w-7xl px-4 py-6 sm:px-6 space-y-6'}>
        {/* KPI Summary Strip */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Tổng số nhóm</div>
            <div className="mt-1 font-display text-2xl font-bold tabular-nums text-slate-900">
              {data.summary.totalGroups}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Tổng học sinh</div>
            <div className="mt-1 font-display text-2xl font-bold tabular-nums text-slate-900">
              {data.summary.totalStudents}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Hoàn thành</div>
            <div className="mt-1 font-display text-2xl font-bold tabular-nums text-emerald-700">
              {data.summary.completedPresentations}/{data.summary.totalGroups}
              <span className="ml-1.5 text-xs font-normal text-slate-500">
                ({data.summary.completionPercentage}%)
              </span>
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Điểm trung bình</div>
            <div className="mt-1 font-display text-2xl font-bold tabular-nums text-slate-900">
              {data.summary.averageScore ?? '—'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Cao nhất</div>
            <div className="mt-1 font-display text-2xl font-bold tabular-nums text-indigo-700">
              {data.summary.highestScore ?? '—'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Thấp nhất</div>
            <div className="mt-1 font-display text-2xl font-bold tabular-nums text-slate-700">
              {data.summary.lowestScore ?? '—'}
            </div>
          </div>
        </section>

        {/* Export & Criterion Sort Controls */}
        <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <label htmlFor="sort-crit" className="text-xs font-medium text-slate-600 whitespace-nowrap">
              Xếp hạng theo:
            </label>
            <select
              id="sort-crit"
              value={sortCriterionId}
              onChange={(e) => setSortCriterionId(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800"
            >
              <option value="TOTAL">Tổng điểm chính thức</option>
              {data.criteria.map((c) => (
                <option key={c.id} value={c.id}>
                  Tiêu chí: {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void downloadAuthenticatedFile(
                  `/api/rooms/${roomId}/export?format=xlsx`,
                  `ket-qua-${data.room.room_code}.xlsx`
                ).catch((err) =>
                  setError(err instanceof Error ? err.message : 'Xuất Excel thất bại.')
                )
              }
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
              <span>Xuất Excel (.xlsx)</span>
            </button>
            <button
              type="button"
              onClick={() =>
                void downloadAuthenticatedFile(
                  `/api/rooms/${roomId}/export?format=csv`,
                  `ket-qua-${data.room.room_code}.csv`
                ).catch((err) =>
                  setError(err instanceof Error ? err.message : 'Xuất CSV thất bại.')
                )
              }
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5 text-slate-700" aria-hidden="true" />
              <span>Xuất CSV</span>
            </button>
            <button
              type="button"
              onClick={() =>
                void downloadAuthenticatedFile(
                  `/api/rooms/${roomId}/export?format=pdf`,
                  `ket-qua-${data.room.room_code}.pdf`
                ).catch((err) =>
                  setError(err instanceof Error ? err.message : 'Xuất PDF thất bại.')
                )
              }
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
            >
              <FileText className="h-3.5 w-3.5 text-red-700" aria-hidden="true" />
              <span>Xuất PDF</span>
            </button>
          </div>
        </section>

        {/* Rankings Table */}
        <section ref={tableRef} className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
              <tr>
                <th className="px-3 py-2.5 align-bottom whitespace-nowrap">Hạng</th>
                <th className="px-3 py-2.5 align-bottom whitespace-nowrap">Nhóm</th>
                <th className="px-2 py-2.5 text-right align-bottom whitespace-nowrap">TV</th>
                <th className="px-2 py-2.5 text-right align-bottom whitespace-nowrap">Phiếu</th>
                {data.criteria.map((c) => (
                  <th
                    key={c.id}
                    className="px-2 py-2.5 text-right align-bottom min-w-[84px] max-w-[116px] leading-snug"
                  >
                    <div>{c.name}</div>
                    <div className="font-mono text-[10px] font-normal text-slate-400 tabular-nums">
                      (/{c.maxScore})
                    </div>
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right align-bottom whitespace-nowrap">
                  <div>Tổng</div>
                  <div className="font-mono text-[10px] font-normal text-slate-400 tabular-nums">
                    (/{maxScore})
                  </div>
                </th>
                <th className="px-3 py-2.5 w-24 align-bottom whitespace-nowrap">Tỷ lệ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {displayedRankings.map((r) => {
                const pct =
                  r.finalScore !== null && maxScore > 0
                    ? Math.min(100, Math.round((r.finalScore / maxScore) * 100))
                    : 0;
                return (
                  <tr key={r.groupId} className="ranking-row-item hover:bg-slate-50/70">
                    <td className="px-3 py-2.5 font-mono font-bold tabular-nums text-slate-900 whitespace-nowrap">
                      {r.rank ? `#${r.rank}` : '—'}
                      {r.isTied && (
                        <span className="ml-1 text-[10px] font-medium text-amber-700">
                          (Đồng hạng)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-slate-900 whitespace-nowrap">
                      {r.groupName}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums text-slate-600">
                      {r.memberCount}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums text-slate-600">
                      {r.submittedGraderCount}
                    </td>
                    {data.criteria.map((c) => (
                      <td
                        key={c.id}
                        className="px-2 py-2.5 text-right font-mono tabular-nums text-slate-700"
                      >
                        {r.criterionAverages[c.id] ?? '—'}
                      </td>
                    ))}
                    <td className="px-3 py-2.5 text-right font-mono text-sm sm:text-base font-bold tabular-nums text-indigo-700 whitespace-nowrap">
                      {r.finalScore ?? '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-2 flex-1 overflow-hidden rounded-sm bg-slate-100">
                          <div
                            className="h-full bg-indigo-600 transition-transform duration-300"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="font-mono text-[11px] tabular-nums text-slate-500 w-8 text-right">
                          {pct}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {/* Consolidated Group Feedback */}
        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Chi tiết nhận xét theo nhóm
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {data.groupDetails.map((gd) => (
              <div key={gd.groupId} className="rounded-lg border border-slate-200 bg-white p-4 space-y-2.5">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <h3 className="font-semibold text-slate-900">{gd.groupName}</h3>
                  <span className="text-xs text-slate-500">{gd.members.length} thành viên</span>
                </div>
                {gd.graderAssessments.length === 0 ? (
                  <div className="text-xs text-slate-400">Chưa có phiếu chấm được nộp.</div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {gd.graderAssessments.map((ga) => (
                      <div key={ga.assessmentId} className="py-2 first:pt-0 last:pb-0 space-y-1 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-800">{ga.graderName}</span>
                          <span className="font-mono font-bold tabular-nums text-slate-900">
                            {ga.totalScore}/{maxScore}
                          </span>
                        </div>
                        {ga.publicFeedback && (
                          <p className="text-slate-700">{ga.publicFeedback}</p>
                        )}
                        {ga.strengths && (
                          <p className="text-emerald-700">
                            <strong>Điểm mạnh:</strong> {ga.strengths}
                          </p>
                        )}
                        {ga.weaknesses && (
                          <p className="text-amber-700">
                            <strong>Cần cải thiện:</strong> {ga.weaknesses}
                          </p>
                        )}
                        {ga.privateNotes && (
                          <p className="inline-flex items-center gap-1 text-slate-500">
                            <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span>Ghi chú nội bộ: {ga.privateNotes}</span>
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
