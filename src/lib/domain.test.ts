import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distributeStudentsEvenly,
  validateAndCalculateTotal,
  computeMaxPossibleScore,
  aggregateAndRankGroups,
  isValidRoomTransition,
  isValidAssessmentTransition,
  type RubricCriterionDef,
} from './domain';

test('distributeStudentsEvenly splits 48 students into 8 groups of 6', () => {
  const students = Array.from({ length: 48 }, (_, i) => `HS${String(i + 1).padStart(3, '0')}`);
  const groups = Array.from({ length: 8 }, (_, i) => ({
    id: `g${i + 1}`,
    maxCapacity: 6,
  }));

  const res = distributeStudentsEvenly(students, groups);
  assert.equal(res.unassignedStudentIds.length, 0);
  for (const g of groups) {
    assert.equal(res.counts[g.id], 6);
  }
  const allAssigned = Object.values(res.assignments).flat();
  assert.equal(new Set(allAssigned).size, 48);
});

test('distributeStudentsEvenly handles uneven 47 students into 8 groups without losing or exceeding capacity', () => {
  const students = Array.from({ length: 47 }, (_, i) => `HS${String(i + 1).padStart(3, '0')}`);
  const groups = Array.from({ length: 8 }, (_, i) => ({
    id: `g${i + 1}`,
    maxCapacity: 7,
  }));

  const res = distributeStudentsEvenly(students, groups);
  assert.equal(res.unassignedStudentIds.length, 0);
  const counts = Object.values(res.counts).sort((a, b) => b - a);
  assert.deepEqual(counts, [6, 6, 6, 6, 6, 6, 6, 5]);
  assert.equal(counts.reduce((a, b) => a + b, 0), 47);
});

test('distributeStudentsEvenly respects custom capacities and preserves existing members', () => {
  const students = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const groups = [
    { id: 'g1', maxCapacity: 2, existingStudentIds: ['s1'] },
    { id: 'g2', maxCapacity: 2, existingStudentIds: ['s2', 's3'] },
    { id: 'g3', maxCapacity: 1 },
  ];

  const res = distributeStudentsEvenly(students, groups, { preserveExisting: true });
  assert.deepEqual(res.assignments.g2, ['s2', 's3']);
  assert.equal(res.counts.g1, 2);
  assert.equal(res.counts.g3, 1);
  assert.equal(res.unassignedStudentIds.length, 1);
});

const defaultCriteria: RubricCriterionDef[] = [
  { id: 'c1', name: 'Nội dung', minScore: 0, maxScore: 20, weight: 20, sortOrder: 1 },
  { id: 'c2', name: 'Cấu trúc', minScore: 0, maxScore: 20, weight: 20, sortOrder: 2 },
  { id: 'c3', name: 'Giao tiếp', minScore: 0, maxScore: 20, weight: 20, sortOrder: 3 },
  { id: 'c4', name: 'Sáng tạo', minScore: 0, maxScore: 15, weight: 15, sortOrder: 4 },
  { id: 'c5', name: 'Làm việc nhóm', minScore: 0, maxScore: 15, weight: 15, sortOrder: 5 },
  { id: 'c6', name: 'Phản biện Q&A', minScore: 0, maxScore: 10, weight: 10, sortOrder: 6 },
];

test('validateAndCalculateTotal computes SUM score and rejects out-of-range scores', () => {
  assert.equal(computeMaxPossibleScore(defaultCriteria, 'SUM'), 100);

  const ok = validateAndCalculateTotal(
    defaultCriteria,
    [
      { criterionId: 'c1', score: 18.5 },
      { criterionId: 'c2', score: 17 },
      { criterionId: 'c3', score: 16.5 },
      { criterionId: 'c4', score: 14 },
      { criterionId: 'c5', score: 13 },
      { criterionId: 'c6', score: 9 },
    ],
    { scoringMode: 'SUM', decimalPrecision: 1, requireAllCriteria: true }
  );
  assert.equal(ok.valid, true);
  assert.equal(ok.totalScore, 88);

  const bad = validateAndCalculateTotal(
    defaultCriteria,
    [{ criterionId: 'c1', score: 25 }],
    { scoringMode: 'SUM', decimalPrecision: 1, requireAllCriteria: true }
  );
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.length >= 2);
});

test('validateAndCalculateTotal computes WEIGHTED score accurately', () => {
  const weightedCriteria: RubricCriterionDef[] = [
    { id: 'c1', name: 'Nội dung', minScore: 0, maxScore: 10, weight: 60, sortOrder: 1 },
    { id: 'c2', name: 'Thuyết trình', minScore: 0, maxScore: 10, weight: 40, sortOrder: 2 },
  ];
  const res = validateAndCalculateTotal(
    weightedCriteria,
    [
      { criterionId: 'c1', score: 9 },
      { criterionId: 'c2', score: 7.5 },
    ],
    { scoringMode: 'WEIGHTED', decimalPrecision: 2, requireAllCriteria: true }
  );
  assert.equal(res.valid, true);
  // (9/10)*60 + (7.5/10)*40 = 54 + 30 = 84
  assert.equal(res.totalScore, 84);
});

test('aggregateAndRankGroups handles multiple graders, weighted policy, and ties deterministically', () => {
  const ranked = aggregateAndRankGroups(
    [
      {
        groupId: 'g1',
        groupName: 'Nhóm 1',
        presentationOrder: 1,
        memberCount: 6,
        submissions: [
          {
            assessmentId: 'a1',
            graderId: 't1',
            graderWeight: 2,
            status: 'SUBMITTED',
            totalScore: 90,
            criterionScores: { c1: 18 },
          },
          {
            assessmentId: 'a2',
            graderId: 'g1',
            graderWeight: 1,
            status: 'SUBMITTED',
            totalScore: 75,
            criterionScores: { c1: 15 },
          },
        ],
      },
      {
        groupId: 'g2',
        groupName: 'Nhóm 2',
        presentationOrder: 2,
        memberCount: 6,
        submissions: [
          {
            assessmentId: 'a3',
            graderId: 't1',
            graderWeight: 2,
            status: 'FINALIZED',
            totalScore: 85,
            criterionScores: { c1: 17 },
          },
        ],
      },
      {
        groupId: 'g3',
        groupName: 'Nhóm 3',
        presentationOrder: 3,
        memberCount: 6,
        submissions: [
          {
            assessmentId: 'a4',
            graderId: 't1',
            graderWeight: 2,
            status: 'SUBMITTED',
            totalScore: 92,
            criterionScores: { c1: 19 },
          },
        ],
      },
    ],
    [defaultCriteria[0]],
    'WEIGHTED_AVERAGE',
    2
  );

  // g3: 92 (rank 1), g1: (90*2 + 75*1)/3 = 85 (rank 2, tied), g2: 85 (rank 2, tied)
  assert.equal(ranked[0].groupId, 'g3');
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].isTied, false);

  assert.equal(ranked[1].groupId, 'g1');
  assert.equal(ranked[1].finalScore, 85);
  assert.equal(ranked[1].rank, 2);
  assert.equal(ranked[1].isTied, true);

  assert.equal(ranked[2].groupId, 'g2');
  assert.equal(ranked[2].finalScore, 85);
  assert.equal(ranked[2].rank, 2);
  assert.equal(ranked[2].isTied, true);
});

test('room and assessment state machines enforce valid transitions', () => {
  assert.equal(isValidRoomTransition('DRAFT', 'REGISTRATION_OPEN').valid, true);
  assert.equal(isValidRoomTransition('DRAFT', 'FINALIZED').valid, false);
  assert.equal(isValidRoomTransition('FINALIZED', 'IN_PROGRESS').valid, false);
  assert.equal(
    isValidRoomTransition('FINALIZED', 'IN_PROGRESS', { reopenConfirmed: true }).valid,
    true
  );

  assert.equal(isValidAssessmentTransition('DRAFT', 'SUBMITTED'), true);
  assert.equal(isValidAssessmentTransition('FINALIZED', 'DRAFT'), false);
});
