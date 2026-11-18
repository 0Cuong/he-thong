export type UserRole = 'SUPER_ADMIN' | 'TEACHER' | 'GRADER' | 'STUDENT';

export type ClassroomStatus = 'ACTIVE' | 'ARCHIVED';

export type RoomStatus =
  | 'DRAFT'
  | 'REGISTRATION_OPEN'
  | 'REGISTRATION_CLOSED'
  | 'READY'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'FINALIZED'
  | 'ARCHIVED';

export type AssessmentStatus =
  | 'DRAFT'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'REVIEWED'
  | 'FINALIZED';

export type ScoringMode = 'SUM' | 'WEIGHTED';
export type MultiGraderPolicy = 'AVERAGE' | 'WEIGHTED_AVERAGE';

export const ROOM_STATUS_LABELS: Record<RoomStatus, string> = {
  DRAFT: 'Bản nháp',
  REGISTRATION_OPEN: 'Mở chọn nhóm',
  REGISTRATION_CLOSED: 'Đóng chọn nhóm',
  READY: 'Sẵn sàng',
  IN_PROGRESS: 'Đang chấm điểm',
  PAUSED: 'Tạm dừng',
  FINALIZED: 'Đã chốt kết quả',
  ARCHIVED: 'Đã lưu trữ',
};

export const ASSESSMENT_STATUS_LABELS: Record<AssessmentStatus, string> = {
  DRAFT: 'Bản nháp',
  IN_PROGRESS: 'Đang chấm',
  SUBMITTED: 'Đã nộp',
  REVIEWED: 'Đã rà soát',
  FINALIZED: 'Đã khóa',
};

export const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: 'Quản trị hệ thống',
  TEACHER: 'Giáo viên',
  GRADER: 'Giám khảo',
  STUDENT: 'Học sinh',
};

const ROOM_TRANSITIONS: Record<RoomStatus, readonly RoomStatus[]> = {
  DRAFT: ['REGISTRATION_OPEN', 'READY', 'ARCHIVED'],
  REGISTRATION_OPEN: ['REGISTRATION_CLOSED', 'READY', 'IN_PROGRESS', 'ARCHIVED'],
  REGISTRATION_CLOSED: ['REGISTRATION_OPEN', 'READY', 'IN_PROGRESS', 'ARCHIVED'],
  READY: ['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'IN_PROGRESS', 'ARCHIVED'],
  IN_PROGRESS: ['PAUSED', 'FINALIZED'],
  PAUSED: ['IN_PROGRESS', 'FINALIZED'],
  FINALIZED: ['IN_PROGRESS', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

export function isValidRoomTransition(
  from: RoomStatus,
  to: RoomStatus,
  options?: { reopenConfirmed?: boolean }
): { valid: boolean; reason?: string } {
  if (from === to) {
    return { valid: true };
  }
  const allowed = ROOM_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return {
      valid: false,
      reason: `Không thể chuyển trạng thái phòng từ "${ROOM_STATUS_LABELS[from]}" sang "${ROOM_STATUS_LABELS[to]}".`,
    };
  }
  if (from === 'FINALIZED' && to === 'IN_PROGRESS' && !options?.reopenConfirmed) {
    return {
      valid: false,
      reason: 'Cần xác nhận mở lại phiên chấm điểm từ trạng thái Đã chốt kết quả.',
    };
  }
  return { valid: true };
}

const ASSESSMENT_TRANSITIONS: Record<AssessmentStatus, readonly AssessmentStatus[]> = {
  DRAFT: ['IN_PROGRESS', 'SUBMITTED'],
  IN_PROGRESS: ['DRAFT', 'SUBMITTED'],
  SUBMITTED: ['REVIEWED', 'FINALIZED'],
  REVIEWED: ['FINALIZED'],
  FINALIZED: [],
};

export function isValidAssessmentTransition(
  from: AssessmentStatus,
  to: AssessmentStatus
): boolean {
  if (from === to) return true;
  return (ASSESSMENT_TRANSITIONS[from] ?? []).includes(to);
}

export interface GroupCapacitySlot {
  id: string;
  name?: string;
  maxCapacity: number;
  existingStudentIds?: string[];
}

export interface DistributionResult {
  assignments: Record<string, string[]>; // groupId -> studentIds[]
  unassignedStudentIds: string[];
  counts: Record<string, number>;
}

/**
 * Distributes students as evenly as possible across groups without exceeding
 * each group's maxCapacity, duplicating students, or losing existing assignments
 * when preserveExisting is true.
 */
export function distributeStudentsEvenly(
  studentIds: readonly string[],
  groups: readonly GroupCapacitySlot[],
  options: { preserveExisting?: boolean } = {}
): DistributionResult {
  const uniqueStudents = Array.from(new Set(studentIds));
  if (groups.length === 0) {
    return {
      assignments: {},
      unassignedStudentIds: uniqueStudents,
      counts: {},
    };
  }

  const preserveExisting = options.preserveExisting ?? false;
  const assignments: Record<string, string[]> = {};
  const assignedSet = new Set<string>();
  const studentSet = new Set(uniqueStudents);

  for (const group of groups) {
    assignments[group.id] = [];
  }

  if (preserveExisting) {
    for (const group of groups) {
      for (const sid of group.existingStudentIds ?? []) {
        if (
          studentSet.has(sid) &&
          !assignedSet.has(sid) &&
          assignments[group.id].length < group.maxCapacity
        ) {
          assignments[group.id].push(sid);
          assignedSet.add(sid);
        }
      }
    }
  }

  const remainingStudents = uniqueStudents.filter((id) => !assignedSet.has(id));

  for (const sid of remainingStudents) {
    // Pick eligible group with lowest current count (ties broken by original order)
    let bestGroup: GroupCapacitySlot | null = null;
    let lowestCount = Infinity;

    for (const group of groups) {
      const currentLen = assignments[group.id].length;
      if (currentLen < group.maxCapacity && currentLen < lowestCount) {
        lowestCount = currentLen;
        bestGroup = group;
      }
    }

    if (!bestGroup) {
      break;
    }

    assignments[bestGroup.id].push(sid);
    assignedSet.add(sid);
  }

  const unassignedStudentIds = uniqueStudents.filter((id) => !assignedSet.has(id));
  const counts: Record<string, number> = {};
  for (const group of groups) {
    counts[group.id] = assignments[group.id].length;
  }

  return { assignments, unassignedStudentIds, counts };
}

export interface RubricCriterionDef {
  id: string;
  name: string;
  minScore: number;
  maxScore: number;
  weight: number;
  sortOrder: number;
}

export interface CriterionScoreInput {
  criterionId: string;
  score: number;
}

export function roundToPrecision(value: number, precision: 0 | 1 | 2): number {
  const factor = Math.pow(10, precision);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function validateAndCalculateTotal(
  criteria: readonly RubricCriterionDef[],
  inputs: readonly CriterionScoreInput[],
  options: {
    scoringMode: ScoringMode;
    decimalPrecision: 0 | 1 | 2;
    requireAllCriteria?: boolean;
  }
): {
  valid: boolean;
  errors: string[];
  totalScore: number;
  normalizedScores: Record<string, number>;
} {
  const errors: string[] = [];
  const inputMap = new Map<string, number>();

  for (const item of inputs) {
    inputMap.set(item.criterionId, item.score);
  }

  const normalizedScores: Record<string, number> = {};
  let totalScore = 0;

  for (const criterion of criteria) {
    const raw = inputMap.get(criterion.id);
    if (raw === undefined || raw === null || Number.isNaN(raw)) {
      if (options.requireAllCriteria) {
        errors.push(`Thiếu điểm cho tiêu chí "${criterion.name}".`);
      }
      continue;
    }

    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      errors.push(`Điểm tiêu chí "${criterion.name}" không hợp lệ.`);
      continue;
    }

    if (raw < criterion.minScore || raw > criterion.maxScore) {
      errors.push(
        `Điểm "${criterion.name}" phải nằm trong khoảng ${criterion.minScore} – ${criterion.maxScore}.`
      );
      continue;
    }

    const rounded = roundToPrecision(raw, options.decimalPrecision);
    normalizedScores[criterion.id] = rounded;

    if (options.scoringMode === 'WEIGHTED') {
      const ratio = criterion.maxScore > 0 ? rounded / criterion.maxScore : 0;
      totalScore += ratio * criterion.weight;
    } else {
      totalScore += rounded;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    totalScore: roundToPrecision(totalScore, options.decimalPrecision),
    normalizedScores,
  };
}

export function computeMaxPossibleScore(
  criteria: readonly RubricCriterionDef[],
  scoringMode: ScoringMode,
  precision: 0 | 1 | 2 = 2
): number {
  if (scoringMode === 'WEIGHTED') {
    const sum = criteria.reduce((acc, c) => acc + c.weight, 0);
    return roundToPrecision(sum, precision);
  }
  const sum = criteria.reduce((acc, c) => acc + c.maxScore, 0);
  return roundToPrecision(sum, precision);
}

export interface GraderSubmissionSummary {
  assessmentId: string;
  graderId: string;
  graderWeight: number;
  status: AssessmentStatus;
  totalScore: number;
  criterionScores: Record<string, number>;
}

export interface GroupResultEntry {
  groupId: string;
  groupName: string;
  presentationOrder: number;
  memberCount: number;
  submittedGraderCount: number;
  finalScore: number | null;
  criterionAverages: Record<string, number | null>;
  rank: number | null;
  isTied: boolean;
}

export function aggregateAndRankGroups(
  groups: ReadonlyArray<{
    groupId: string;
    groupName: string;
    presentationOrder: number;
    memberCount: number;
    submissions: readonly GraderSubmissionSummary[];
  }>,
  criteria: readonly RubricCriterionDef[],
  policy: MultiGraderPolicy,
  precision: 0 | 1 | 2 = 2
): GroupResultEntry[] {
  const eligibleStatuses = new Set<AssessmentStatus>(['SUBMITTED', 'REVIEWED', 'FINALIZED']);

  const aggregated = groups.map((group) => {
    const validSubs = group.submissions.filter((s) => eligibleStatuses.has(s.status));
    const criterionAverages: Record<string, number | null> = {};

    if (validSubs.length === 0) {
      for (const c of criteria) {
        criterionAverages[c.id] = null;
      }
      return {
        groupId: group.groupId,
        groupName: group.groupName,
        presentationOrder: group.presentationOrder,
        memberCount: group.memberCount,
        submittedGraderCount: 0,
        finalScore: null,
        criterionAverages,
        rank: null,
        isTied: false,
      };
    }

    let finalScore = 0;
    if (policy === 'WEIGHTED_AVERAGE') {
      const totalWeight = validSubs.reduce((acc, s) => acc + (s.graderWeight > 0 ? s.graderWeight : 1), 0);
      finalScore =
        validSubs.reduce(
          (acc, s) => acc + s.totalScore * (s.graderWeight > 0 ? s.graderWeight : 1),
          0
        ) / totalWeight;
    } else {
      finalScore = validSubs.reduce((acc, s) => acc + s.totalScore, 0) / validSubs.length;
    }

    for (const c of criteria) {
      const scored = validSubs.filter((s) => s.criterionScores[c.id] !== undefined);
      if (scored.length === 0) {
        criterionAverages[c.id] = null;
      } else if (policy === 'WEIGHTED_AVERAGE') {
        const wSum = scored.reduce((acc, s) => acc + (s.graderWeight > 0 ? s.graderWeight : 1), 0);
        const avg =
          scored.reduce(
            (acc, s) => acc + s.criterionScores[c.id] * (s.graderWeight > 0 ? s.graderWeight : 1),
            0
          ) / wSum;
        criterionAverages[c.id] = roundToPrecision(avg, precision);
      } else {
        const avg = scored.reduce((acc, s) => acc + s.criterionScores[c.id], 0) / scored.length;
        criterionAverages[c.id] = roundToPrecision(avg, precision);
      }
    }

    return {
      groupId: group.groupId,
      groupName: group.groupName,
      presentationOrder: group.presentationOrder,
      memberCount: group.memberCount,
      submittedGraderCount: validSubs.length,
      finalScore: roundToPrecision(finalScore, precision),
      criterionAverages,
      rank: null as number | null,
      isTied: false,
    };
  });

  // Deterministic sort: scored groups descending by finalScore, then ascending by presentationOrder, then groupName
  const sorted = [...aggregated].sort((a, b) => {
    if (a.finalScore === null && b.finalScore === null) {
      return a.presentationOrder - b.presentationOrder || a.groupName.localeCompare(b.groupName, 'vi');
    }
    if (a.finalScore === null) return 1;
    if (b.finalScore === null) return -1;
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    return a.presentationOrder - b.presentationOrder || a.groupName.localeCompare(b.groupName, 'vi');
  });

  // Standard competition ranking (1, 1, 3...) with tie detection
  const scoreFreq = new Map<number, number>();
  for (const item of sorted) {
    if (item.finalScore !== null) {
      scoreFreq.set(item.finalScore, (scoreFreq.get(item.finalScore) ?? 0) + 1);
    }
  }

  let currentRank = 0;
  let lastScore: number | null = null;
  sorted.forEach((item, index) => {
    if (item.finalScore === null) {
      item.rank = null;
      item.isTied = false;
      return;
    }
    if (lastScore === null || item.finalScore !== lastScore) {
      currentRank = index + 1;
      lastScore = item.finalScore;
    }
    item.rank = currentRank;
    item.isTied = (scoreFreq.get(item.finalScore) ?? 0) > 1;
  });

  return sorted;
}
