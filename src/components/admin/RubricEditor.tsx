import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { computeMaxPossibleScore, type ScoringMode } from '../../lib/domain';

interface EditableCriterion {
  id: string;
  name: string;
  description: string;
  minScore: number;
  maxScore: number;
  weight: number;
}

export function RubricEditor({ roomId }: { roomId: string }) {
  const [title, setTitle] = useState('Rubric Thuyết trình Thang điểm 10');
  const [scoringMode, setScoringMode] = useState<ScoringMode>('SUM');
  const [decimalPrecision, setDecimalPrecision] = useState<0 | 1 | 2>(2);
  const [criteria, setCriteria] = useState<EditableCriterion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadRubric = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    try {
      const data = await apiFetch<{ rubric: any; criteria: any[] }>(`/api/rooms/${roomId}`);
      if (data.rubric) {
        setTitle(data.rubric.title);
        setScoringMode(data.rubric.scoring_mode);
        setDecimalPrecision(data.rubric.decimal_precision);
      }
      setCriteria(
        (data.criteria ?? []).map((c: any) => ({
          id: c.id,
          name: c.name,
          description: c.description || '',
          minScore: c.min_score ?? 0,
          maxScore: c.max_score ?? 10,
          weight: c.weight ?? 10,
        }))
      );
    } catch (err) {
      setNotice({
        type: 'error',
        text: err instanceof Error ? err.message : 'Không thể tải thang điểm.',
      });
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    void loadRubric();
  }, [loadRubric]);

  const maxTotal = computeMaxPossibleScore(
    criteria.map((c, idx) => ({ ...c, sortOrder: idx + 1 })),
    scoringMode,
    decimalPrecision
  );

  const exceedsMaxScale = maxTotal > 10;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (exceedsMaxScale) {
      setNotice({
        type: 'error',
        text: `Tổng điểm tối đa hiện tại (${maxTotal}) vượt quá thang điểm 10. Vui lòng điều chỉnh xuống tối đa 10 điểm.`,
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await apiFetch(`/api/rooms/${roomId}/rubric`, {
        method: 'PUT',
        body: JSON.stringify({
          title,
          scoringMode,
          decimalPrecision,
          criteria,
        }),
      });
      setNotice({
        type: 'success',
        text: `Đã lưu thang điểm (${criteria.length} tiêu chí, tổng tối đa ${maxTotal}/10 điểm).`,
      });
      await loadRubric();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Lưu tiêu chí thất bại.' });
    } finally {
      setBusy(false);
    }
  };

  if (!roomId) return <div className="text-sm text-slate-500">Chọn phòng để cấu hình thang điểm.</div>;
  if (loading) return <div className="text-sm text-slate-500">Đang tải thang điểm...</div>;

  return (
    <form onSubmit={handleSave} className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-xl font-bold text-slate-900">
            Cấu hình Tiêu chí Chấm điểm (Thang điểm 10)
          </h2>
          <p className="text-sm text-slate-600">
            Tổng điểm tối đa tự động tính từ các tiêu chí hiện tại:{' '}
            <strong className={`font-mono ${exceedsMaxScale ? 'text-red-600' : 'text-indigo-700'}`}>
              {maxTotal} / 10 điểm
            </strong>
            .
          </p>
        </div>

        <button
          type="submit"
          disabled={busy || exceedsMaxScale}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap"
        >
          <Save className="h-4 w-4" aria-hidden="true" />
          <span>{busy ? 'Đang lưu...' : 'Lưu thang điểm'}</span>
        </button>
      </div>

      {exceedsMaxScale && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          Thang điểm tối đa chỉ cho phép <strong>10 điểm</strong> (hiện tại là <strong>{maxTotal}</strong> điểm). Vui lòng giảm điểm tối đa của một số tiêu chí trước khi lưu.
        </div>
      )}

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

      <div className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-5 sm:grid-cols-3">
        <div>
          <label className="block text-xs font-medium text-slate-600">Tên thang điểm</label>
          <input
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600">Phương thức tính tổng</label>
          <select
            value={scoringMode}
            onChange={(e) => setScoringMode(e.target.value as ScoringMode)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="SUM">Cộng tổng trực tiếp các tiêu chí</option>
            <option value="WEIGHTED">Quy đổi theo trọng số từng tiêu chí</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600">Làm tròn thập phân</label>
          <select
            value={decimalPrecision}
            onChange={(e) => setDecimalPrecision(Number(e.target.value) as 0 | 1 | 2)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value={0}>Số nguyên (0 chữ số)</option>
            <option value={1}>1 chữ số (VD: 8.5)</option>
            <option value={2}>2 chữ số (VD: 8.75)</option>
          </select>
        </div>
      </div>

      <div className="space-y-3">
        {criteria.map((c, idx) => (
          <div key={c.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end">
              <div className="sm:col-span-4">
                <label className="block text-xs font-medium text-slate-600">
                  Tiêu chí #{idx + 1}
                </label>
                <input
                  type="text"
                  required
                  value={c.name}
                  onChange={(e) =>
                    setCriteria((prev) =>
                      prev.map((item, i) => (i === idx ? { ...item, name: e.target.value } : item))
                    )
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-medium"
                />
              </div>

              <div className="sm:col-span-3">
                <label className="block text-xs font-medium text-slate-600">Mô tả ngắn</label>
                <input
                  type="text"
                  value={c.description}
                  onChange={(e) =>
                    setCriteria((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, description: e.target.value } : item
                      )
                    )
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div className="sm:col-span-1">
                <label className="block text-xs font-medium text-slate-600">Min</label>
                <input
                  type="number"
                  min={0}
                  step={0.25}
                  value={c.minScore}
                  onChange={(e) =>
                    setCriteria((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, minScore: Number(e.target.value) } : item
                      )
                    )
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 font-mono text-sm"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-600">Điểm tối đa</label>
                <input
                  type="number"
                  min={0.25}
                  max={10}
                  step={0.25}
                  value={c.maxScore}
                  onChange={(e) =>
                    setCriteria((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, maxScore: Number(e.target.value) } : item
                      )
                    )
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 font-mono text-sm"
                />
              </div>

              <div className="sm:col-span-1">
                <label className="block text-xs font-medium text-slate-600">Trọng số</label>
                <input
                  type="number"
                  min={0.25}
                  step={0.25}
                  value={c.weight}
                  onChange={(e) =>
                    setCriteria((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, weight: Number(e.target.value) } : item
                      )
                    )
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 font-mono text-sm"
                />
              </div>

              <div className="sm:col-span-1 flex justify-end">
                <button
                  type="button"
                  disabled={criteria.length <= 1}
                  onClick={() => setCriteria((prev) => prev.filter((_, i) => i !== idx))}
                  aria-label={`Xóa tiêu chí ${c.name}`}
                  className="min-h-[38px] rounded-md border border-red-200 px-2.5 text-red-600 hover:bg-red-50 disabled:opacity-30"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={() =>
            setCriteria((prev) => [
              ...prev,
              {
                id: `crit_new_${Date.now()}_${prev.length}`,
                name: `Tiêu chí mới ${prev.length + 1}`,
                description: '',
                minScore: 0,
                maxScore: 1,
                weight: 1,
              },
            ])
          }
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-dashed border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:border-indigo-500 hover:text-indigo-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>Thêm tiêu chí mới</span>
        </button>
      </div>
    </form>
  );
}
