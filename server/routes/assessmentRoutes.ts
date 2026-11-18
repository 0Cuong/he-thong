import crypto from 'node:crypto';
import { Router } from 'express';
import type { DB } from '../db.ts';
import type { RealtimeHub } from '../realtime.ts';
import {
  canAccessRoom,
  requireAuth,
  requireRole,
  writeAuditLog,
  type AuthedRequest,
} from '../middleware.ts';
import {
  rateLimitMiddleware,
  sanitizeText,
  SlidingWindowRateLimiter,
} from '../security.ts';
import {
  aggregateAndRankGroups,
  isValidAssessmentTransition,
  validateAndCalculateTotal,
  type AssessmentStatus,
  type MultiGraderPolicy,
  type RoomStatus,
  type RubricCriterionDef,
  type ScoringMode,
} from '../../src/lib/domain.ts';
import {
  generateCsvString,
  generatePdfBuffer,
  generateXlsxBuffer,
  type ExportRoomContext,
} from '../exports.ts';

function getRoomRubricAndCriteria(db: DB, roomId: string) {
  const rubric = db
    .prepare('SELECT * FROM scoring_rubrics WHERE room_id = ?')
    .get(roomId) as
    | {
        id: string;
        room_id: string;
        title: string;
        scoring_mode: ScoringMode;
        decimal_precision: 0 | 1 | 2;
        max_total_score: number;
      }
    | undefined;

  const criteria = rubric
    ? (db
        .prepare(
          `SELECT id, name, description, min_score as minScore, max_score as maxScore, weight, sort_order as sortOrder
           FROM rubric_criteria WHERE rubric_id = ? ORDER BY sort_order ASC`
        )
        .all(rubric.id) as Array<RubricCriterionDef & { description: string }>)
    : [];

  return { rubric, criteria };
}

function buildResultsPayload(db: DB, roomId: string, includePrivateForAdmin: boolean) {
  const room = db
    .prepare(
      `SELECT r.*, c.name as classroom_name, c.code as classroom_code
       FROM rooms r
       JOIN classrooms c ON c.id = r.classroom_id
       WHERE r.id = ?`
    )
    .get(roomId) as
    | {
        id: string;
        name: string;
        room_code: string;
        session_date: string;
        status: RoomStatus;
        multi_grader_policy: MultiGraderPolicy;
        publish_results: number;
        publish_feedback: number;
        classroom_name: string;
      }
    | undefined;

  if (!room) return null;

  const { rubric, criteria } = getRoomRubricAndCriteria(db, roomId);
  const precision = rubric?.decimal_precision ?? 1;

  const groups = db
    .prepare(
      `SELECT g.id as groupId, g.name as groupName, g.presentation_order as presentationOrder,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) as memberCount
       FROM groups g
       WHERE g.room_id = ?
       ORDER BY g.presentation_order ASC, g.name ASC`
    )
    .all(roomId) as Array<{
    groupId: string;
    groupName: string;
    presentationOrder: number;
    memberCount: number;
  }>;

  const assessments = db
    .prepare(
      `SELECT a.id as assessmentId, a.group_id, a.grader_id, a.status, a.total_score, a.submitted_at,
              COALESCE(rm.grader_weight, 1.0) as graderWeight,
              COALESCE(p.full_name, u.username) as graderName,
              ac.overall_comment, ac.strengths, ac.weaknesses, ac.suggestions, ac.public_feedback,
              ${includePrivateForAdmin ? 'ac.private_notes' : "'' as private_notes"}
       FROM assessments a
       JOIN users u ON u.id = a.grader_id
       LEFT JOIN profiles p ON p.user_id = a.grader_id
       LEFT JOIN room_members rm ON rm.room_id = a.room_id AND rm.user_id = a.grader_id
       LEFT JOIN assessment_comments ac ON ac.assessment_id = a.id
       WHERE a.room_id = ?`
    )
    .all(roomId) as Array<{
    assessmentId: string;
    group_id: string;
    grader_id: string;
    status: AssessmentStatus;
    total_score: number;
    submitted_at: string | null;
    graderWeight: number;
    graderName: string;
    overall_comment: string | null;
    strengths: string | null;
    weaknesses: string | null;
    suggestions: string | null;
    public_feedback: string | null;
    private_notes: string | null;
  }>;

  const scoreRows = db
    .prepare(
      `SELECT s.assessment_id, s.criterion_id, s.score, s.comment
       FROM assessment_scores s
       JOIN assessments a ON a.id = s.assessment_id
       WHERE a.room_id = ?`
    )
    .all(roomId) as Array<{
    assessment_id: string;
    criterion_id: string;
    score: number;
    comment: string;
  }>;

  const scoreMap = new Map<string, Record<string, number>>();
  for (const s of scoreRows) {
    if (!scoreMap.has(s.assessment_id)) scoreMap.set(s.assessment_id, {});
    scoreMap.get(s.assessment_id)![s.criterion_id] = s.score;
  }

  const rankings = aggregateAndRankGroups(
    groups.map((g) => ({
      ...g,
      submissions: assessments
        .filter((a) => a.group_id === g.groupId)
        .map((a) => ({
          assessmentId: a.assessmentId,
          graderId: a.grader_id,
          graderWeight: a.graderWeight,
          status: a.status,
          totalScore: a.total_score,
          criterionScores: scoreMap.get(a.assessmentId) ?? {},
        })),
    })),
    criteria,
    room.multi_grader_policy,
    precision
  );

  const scoredValues = rankings
    .map((r) => r.finalScore)
    .filter((v): v is number => v !== null);

  const totalGroups = groups.length;
  const completedGroups = scoredValues.length;
  const totalStudents = (
    db
      .prepare(`SELECT COUNT(*) as c FROM room_members WHERE room_id = ? AND room_role = 'STUDENT'`)
      .get(roomId) as { c: number }
  ).c;

  const avgScore =
    scoredValues.length > 0
      ? Number((scoredValues.reduce((a, b) => a + b, 0) / scoredValues.length).toFixed(precision))
      : null;
  const highestScore = scoredValues.length > 0 ? Math.max(...scoredValues) : null;
  const lowestScore = scoredValues.length > 0 ? Math.min(...scoredValues) : null;

  const membersRows = db
    .prepare(
      `SELECT gm.group_id, COALESCE(p.student_code, u.username) as studentCode,
              COALESCE(p.full_name, u.username) as fullName
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       LEFT JOIN profiles p ON p.user_id = gm.user_id
       WHERE gm.room_id = ?
       ORDER BY studentCode ASC`
    )
    .all(roomId) as Array<{ group_id: string; studentCode: string; fullName: string }>;

  const membersByGroup = new Map<string, Array<{ studentCode: string; fullName: string }>>();
  for (const m of membersRows) {
    if (!membersByGroup.has(m.group_id)) membersByGroup.set(m.group_id, []);
    membersByGroup.get(m.group_id)!.push({ studentCode: m.studentCode, fullName: m.fullName });
  }

  const eligibleStatuses = new Set(['SUBMITTED', 'REVIEWED', 'FINALIZED']);
  const groupDetails = groups.map((g) => ({
    groupId: g.groupId,
    groupName: g.groupName,
    members: membersByGroup.get(g.groupId) ?? [],
    graderAssessments: assessments
      .filter((a) => a.group_id === g.groupId && eligibleStatuses.has(a.status))
      .map((a) => ({
        assessmentId: a.assessmentId,
        graderId: a.grader_id,
        graderName: a.graderName,
        status: a.status,
        totalScore: a.total_score,
        submittedAt: a.submitted_at,
        overallComment: a.overall_comment ?? '',
        strengths: a.strengths ?? '',
        weaknesses: a.weaknesses ?? '',
        suggestions: a.suggestions ?? '',
        publicFeedback: a.public_feedback ?? '',
        ...(includePrivateForAdmin ? { privateNotes: a.private_notes ?? '' } : {}),
      })),
  }));

  return {
    room,
    rubric,
    criteria,
    summary: {
      totalGroups,
      totalStudents,
      completedPresentations: completedGroups,
      pendingAssessments: totalGroups - completedGroups,
      completionPercentage: totalGroups > 0 ? Math.round((completedGroups / totalGroups) * 100) : 0,
      averageScore: avgScore,
      highestScore,
      lowestScore,
    },
    rankings,
    groupDetails,
  };
}

export function createAssessmentRouter(db: DB, realtime: RealtimeHub) {
  const router = Router();
  const scoringLimiter = new SlidingWindowRateLimiter(60 * 1000, 120);

  // Fetch assessments visible to the current user in a room
  router.get('/rooms/:roomId/assessments', requireAuth, (req: AuthedRequest, res) => {
    const { roomId } = req.params;
    const user = req.user!;

    if (!canAccessRoom(db, user, roomId)) {
      res.status(403).json({ error: 'Bạn không có quyền truy cập phòng này.' });
      return;
    }

    // Students NEVER get draft assessments or private teacher notes
    if (user.role === 'STUDENT') {
      res.status(403).json({ error: 'Học sinh chỉ xem được kết quả đã công bố tại mục Kết quả.' });
      return;
    }

    const isAdminOrTeacher = user.role === 'SUPER_ADMIN' || user.role === 'TEACHER';
    const assessments = isAdminOrTeacher
      ? db
          .prepare(
            `SELECT a.*, COALESCE(p.full_name, u.username) as grader_name, u.username as grader_username
             FROM assessments a
             JOIN users u ON u.id = a.grader_id
             LEFT JOIN profiles p ON p.user_id = a.grader_id
             WHERE a.room_id = ?
             ORDER BY a.updated_at DESC`
          )
          .all(roomId)
      : db
          .prepare(
            `SELECT a.*, COALESCE(p.full_name, u.username) as grader_name, u.username as grader_username
             FROM assessments a
             JOIN users u ON u.id = a.grader_id
             LEFT JOIN profiles p ON p.user_id = a.grader_id
             WHERE a.room_id = ? AND a.grader_id = ?
             ORDER BY a.updated_at DESC`
          )
          .all(roomId, user.id);

    const typedAssessments = assessments as Array<{ id: string }>;
    const ids = typedAssessments.map((a) => a.id);

    if (ids.length === 0) {
      res.json({ assessments: [] });
      return;
    }

    const placeholders = ids.map(() => '?').join(',');
    const scores = db
      .prepare(`SELECT * FROM assessment_scores WHERE assessment_id IN (${placeholders})`)
      .all(...ids) as Array<{
      assessment_id: string;
      criterion_id: string;
      score: number;
      comment: string;
    }>;

    const comments = db
      .prepare(`SELECT * FROM assessment_comments WHERE assessment_id IN (${placeholders})`)
      .all(...ids) as Array<{
      assessment_id: string;
      overall_comment: string;
      strengths: string;
      weaknesses: string;
      suggestions: string;
      public_feedback: string;
      private_notes: string;
    }>;

    const revisions = db
      .prepare(
        `SELECT r.*, COALESCE(p.full_name, u.username) as changed_by_name
         FROM assessment_revisions r
         JOIN users u ON u.id = r.changed_by
         LEFT JOIN profiles p ON p.user_id = r.changed_by
         WHERE r.assessment_id IN (${placeholders})
         ORDER BY r.revision_number DESC`
      )
      .all(...ids) as Array<{ assessment_id: string }>;

    const scoresMap = new Map<string, typeof scores>();
    for (const sc of scores) {
      if (!scoresMap.has(sc.assessment_id)) scoresMap.set(sc.assessment_id, []);
      scoresMap.get(sc.assessment_id)!.push(sc);
    }

    const commentsMap = new Map(comments.map((c) => [c.assessment_id, c]));
    const revisionsMap = new Map<string, typeof revisions>();
    for (const rv of revisions) {
      if (!revisionsMap.has(rv.assessment_id)) revisionsMap.set(rv.assessment_id, []);
      revisionsMap.get(rv.assessment_id)!.push(rv);
    }

    const enriched = typedAssessments.map((a) => ({
      ...a,
      scores: scoresMap.get(a.id) ?? [],
      comments: commentsMap.get(a.id) ?? null,
      revisions: revisionsMap.get(a.id) ?? [],
    }));

    res.json({ assessments: enriched });
  });

  // Save draft / in-progress assessment for current grader (server-calculated total, optimistic version check)
  router.put(
    '/rooms/:roomId/groups/:groupId/assessment',
    requireRole('SUPER_ADMIN', 'TEACHER', 'GRADER'),
    rateLimitMiddleware(scoringLimiter, (req: AuthedRequest) => req.user!.id),
    (req: AuthedRequest, res) => {
      const { roomId, groupId } = req.params;
      const user = req.user!;

      if (!canAccessRoom(db, user, roomId)) {
        res.status(403).json({ error: 'Bạn không được phân công chấm phòng này.' });
        return;
      }

      const room = db.prepare('SELECT id, status FROM rooms WHERE id = ?').get(roomId) as
        | { id: string; status: RoomStatus }
        | undefined;
      const group = db
        .prepare('SELECT id, name FROM groups WHERE id = ? AND room_id = ?')
        .get(groupId, roomId) as { id: string; name: string } | undefined;

      if (!room || !group) {
        res.status(404).json({ error: 'Không tìm thấy phòng hoặc nhóm.' });
        return;
      }
      if (room.status === 'FINALIZED' || room.status === 'ARCHIVED') {
        res.status(400).json({ error: 'Phòng đã chốt kết quả, không thể chỉnh sửa bản nháp.' });
        return;
      }

      const { rubric, criteria } = getRoomRubricAndCriteria(db, roomId);
      if (!rubric) {
        res.status(400).json({ error: 'Phòng chưa có thang điểm.' });
        return;
      }

      const rawScores = Array.isArray(req.body?.scores) ? req.body.scores : [];
      const scoreInputs = rawScores
        .filter((s: { criterionId?: unknown; score?: unknown }) => typeof s?.criterionId === 'string' && s.score !== '' && s.score !== null && s.score !== undefined)
        .map((s: { criterionId: string; score: unknown; comment?: unknown }) => ({
          criterionId: s.criterionId,
          score: Number(s.score),
          comment: sanitizeText(s.comment, 500),
        }));

      const calc = validateAndCalculateTotal(criteria, scoreInputs, {
        scoringMode: rubric.scoring_mode,
        decimalPrecision: rubric.decimal_precision,
        requireAllCriteria: false,
      });

      if (!calc.valid) {
        res.status(400).json({ error: calc.errors[0], errors: calc.errors });
        return;
      }

      const expectedVersion =
        typeof req.body?.version === 'number' ? req.body.version : undefined;

      const comments = req.body?.comments ?? {};
      const overallComment = sanitizeText(comments.overallComment, 3000);
      const strengths = sanitizeText(comments.strengths, 2000);
      const weaknesses = sanitizeText(comments.weaknesses, 2000);
      const suggestions = sanitizeText(comments.suggestions, 2000);
      const publicFeedback = sanitizeText(comments.publicFeedback, 3000);
      const privateNotes = sanitizeText(comments.privateNotes, 3000);

      try {
        const saved = db
          .transaction(() => {
            const existing = db
              .prepare(
                `SELECT id, status, version FROM assessments WHERE room_id = ? AND group_id = ? AND grader_id = ?`
              )
              .get(roomId, groupId, user.id) as
              | { id: string; status: AssessmentStatus; version: number }
              | undefined;

            if (existing && (existing.status === 'SUBMITTED' || existing.status === 'REVIEWED' || existing.status === 'FINALIZED')) {
              throw new Error('LOCKED:Phiếu chấm đã nộp. Hãy dùng chức năng "Hiệu chỉnh điểm" để ghi nhận thay đổi có lý do.');
            }

            if (existing && expectedVersion !== undefined && existing.version !== expectedVersion) {
              throw new Error('CONFLICT:Dữ liệu phiếu chấm đã được cập nhật từ phiên khác. Vui lòng tải lại dữ liệu mới nhất.');
            }

            const assessmentId = existing?.id ?? `asmt_${crypto.randomUUID().slice(0, 10)}`;
            const nextStatus: AssessmentStatus = scoreInputs.length > 0 ? 'IN_PROGRESS' : 'DRAFT';
            const nextVersion = (existing?.version ?? 0) + 1;

            if (existing) {
              db.prepare(
                `UPDATE assessments
                 SET status = ?, total_score = ?, version = ?, updated_at = datetime('now')
                 WHERE id = ?`
              ).run(nextStatus, calc.totalScore, nextVersion, assessmentId);
            } else {
              db.prepare(
                `INSERT INTO assessments (id, room_id, group_id, grader_id, status, total_score, version)
                 VALUES (?, ?, ?, ?, ?, ?, 1)`
              ).run(assessmentId, roomId, groupId, user.id, nextStatus, calc.totalScore);
            }

            db.prepare('DELETE FROM assessment_scores WHERE assessment_id = ?').run(assessmentId);
            const insertScore = db.prepare(
              `INSERT INTO assessment_scores (id, assessment_id, criterion_id, score, comment)
               VALUES (?, ?, ?, ?, ?)`
            );
            for (const item of scoreInputs) {
              if (calc.normalizedScores[item.criterionId] !== undefined) {
                insertScore.run(
                  crypto.randomUUID(),
                  assessmentId,
                  item.criterionId,
                  calc.normalizedScores[item.criterionId],
                  item.comment
                );
              }
            }

            db.prepare(
              `INSERT INTO assessment_comments (
                 id, assessment_id, overall_comment, strengths, weaknesses, suggestions, public_feedback, private_notes, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(assessment_id) DO UPDATE SET
                 overall_comment = excluded.overall_comment,
                 strengths = excluded.strengths,
                 weaknesses = excluded.weaknesses,
                 suggestions = excluded.suggestions,
                 public_feedback = excluded.public_feedback,
                 private_notes = excluded.private_notes,
                 updated_at = datetime('now')`
            ).run(
              crypto.randomUUID(),
              assessmentId,
              overallComment,
              strengths,
              weaknesses,
              suggestions,
              publicFeedback,
              privateNotes
            );

            return {
              id: assessmentId,
              status: nextStatus,
              totalScore: calc.totalScore,
              version: nextVersion,
              savedAt: new Date().toISOString(),
            };
          })
          .immediate();

        realtime.broadcast(roomId, 'assessment:updated', {
          groupId,
          graderId: user.id,
          status: saved.status,
        });

        res.json({ assessment: saved });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Không thể lưu phiếu chấm.';
        if (msg.startsWith('CONFLICT:')) {
          res.status(409).json({ error: msg.replace('CONFLICT:', '') });
        } else if (msg.startsWith('LOCKED:')) {
          res.status(400).json({ error: msg.replace('LOCKED:', '') });
        } else {
          res.status(400).json({ error: msg });
        }
      }
    }
  );

  // Idempotent official submission
  router.post(
    '/rooms/:roomId/groups/:groupId/assessment/submit',
    requireRole('SUPER_ADMIN', 'TEACHER', 'GRADER'),
    rateLimitMiddleware(scoringLimiter, (req: AuthedRequest) => req.user!.id),
    (req: AuthedRequest, res) => {
      const { roomId, groupId } = req.params;
      const user = req.user!;
      const idempotencyKey = sanitizeText(req.body?.idempotencyKey, 120);

      if (!canAccessRoom(db, user, roomId)) {
        res.status(403).json({ error: 'Bạn không được phân công chấm phòng này.' });
        return;
      }

      const room = db.prepare('SELECT id, status FROM rooms WHERE id = ?').get(roomId) as
        | { id: string; status: RoomStatus }
        | undefined;
      const group = db
        .prepare('SELECT id, name FROM groups WHERE id = ? AND room_id = ?')
        .get(groupId, roomId) as { id: string; name: string } | undefined;

      if (!room || !group) {
        res.status(404).json({ error: 'Không tìm thấy phòng hoặc nhóm.' });
        return;
      }

      if (room.status !== 'IN_PROGRESS' && room.status !== 'PAUSED' && room.status !== 'READY') {
        res.status(400).json({
          error: 'Chỉ có thể nộp phiếu chấm khi phòng đang ở trạng thái Sẵn sàng hoặc Đang chấm điểm.',
        });
        return;
      }

      const { rubric, criteria } = getRoomRubricAndCriteria(db, roomId);
      if (!rubric || criteria.length === 0) {
        res.status(400).json({ error: 'Phòng chưa cấu hình tiêu chí chấm điểm.' });
        return;
      }

      const rawScores = Array.isArray(req.body?.scores) ? req.body.scores : [];
      const scoreInputs = rawScores.map(
        (s: { criterionId: string; score: unknown; comment?: unknown }) => ({
          criterionId: String(s.criterionId ?? ''),
          score: Number(s.score),
          comment: sanitizeText(s.comment, 500),
        })
      );

      const calc = validateAndCalculateTotal(criteria, scoreInputs, {
        scoringMode: rubric.scoring_mode,
        decimalPrecision: rubric.decimal_precision,
        requireAllCriteria: true,
      });

      if (!calc.valid) {
        res.status(400).json({ error: calc.errors[0], errors: calc.errors });
        return;
      }

      const comments = req.body?.comments ?? {};
      const overallComment = sanitizeText(comments.overallComment, 3000);
      const strengths = sanitizeText(comments.strengths, 2000);
      const weaknesses = sanitizeText(comments.weaknesses, 2000);
      const suggestions = sanitizeText(comments.suggestions, 2000);
      const publicFeedback = sanitizeText(comments.publicFeedback, 3000);
      const privateNotes = sanitizeText(comments.privateNotes, 3000);

      try {
        const result = db
          .transaction(() => {
            const existing = db
              .prepare(
                `SELECT id, status, version, idempotency_key, total_score FROM assessments WHERE room_id = ? AND group_id = ? AND grader_id = ?`
              )
              .get(roomId, groupId, user.id) as
              | {
                  id: string;
                  status: AssessmentStatus;
                  version: number;
                  idempotency_key: string | null;
                  total_score: number;
                }
              | undefined;

            // Idempotent replay protection
            if (existing && idempotencyKey && existing.idempotency_key === idempotencyKey) {
              return {
                id: existing.id,
                status: existing.status,
                totalScore: existing.total_score,
                version: existing.version,
                deduplicated: true,
              };
            }

            if (existing && existing.status !== 'DRAFT' && existing.status !== 'IN_PROGRESS') {
              throw new Error(
                'ALREADY_SUBMITTED:Phiếu chấm này đã được nộp trước đó. Vui lòng dùng tính năng Hiệu chỉnh điểm để thay đổi.'
              );
            }

            const assessmentId = existing?.id ?? `asmt_${crypto.randomUUID().slice(0, 10)}`;
            const nextVersion = (existing?.version ?? 0) + 1;

            if (existing) {
              db.prepare(
                `UPDATE assessments
                 SET status = 'SUBMITTED', total_score = ?, version = ?, idempotency_key = ?, submitted_at = datetime('now'), updated_at = datetime('now')
                 WHERE id = ?`
              ).run(calc.totalScore, nextVersion, idempotencyKey || null, assessmentId);
            } else {
              db.prepare(
                `INSERT INTO assessments (id, room_id, group_id, grader_id, status, total_score, version, idempotency_key, submitted_at)
                 VALUES (?, ?, ?, ?, 'SUBMITTED', ?, 1, ?, datetime('now'))`
              ).run(assessmentId, roomId, groupId, user.id, calc.totalScore, idempotencyKey || null);
            }

            db.prepare('DELETE FROM assessment_scores WHERE assessment_id = ?').run(assessmentId);
            const insertScore = db.prepare(
              `INSERT INTO assessment_scores (id, assessment_id, criterion_id, score, comment)
               VALUES (?, ?, ?, ?, ?)`
            );
            for (const item of scoreInputs) {
              insertScore.run(
                crypto.randomUUID(),
                assessmentId,
                item.criterionId,
                calc.normalizedScores[item.criterionId],
                item.comment
              );
            }

            db.prepare(
              `INSERT INTO assessment_comments (
                 id, assessment_id, overall_comment, strengths, weaknesses, suggestions, public_feedback, private_notes, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(assessment_id) DO UPDATE SET
                 overall_comment = excluded.overall_comment,
                 strengths = excluded.strengths,
                 weaknesses = excluded.weaknesses,
                 suggestions = excluded.suggestions,
                 public_feedback = excluded.public_feedback,
                 private_notes = excluded.private_notes,
                 updated_at = datetime('now')`
            ).run(
              crypto.randomUUID(),
              assessmentId,
              overallComment,
              strengths,
              weaknesses,
              suggestions,
              publicFeedback,
              privateNotes
            );

            // Preserve initial immutable revision
            const maxRev = (
              db
                .prepare('SELECT COALESCE(MAX(revision_number), 0) as m FROM assessment_revisions WHERE assessment_id = ?')
                .get(assessmentId) as { m: number }
            ).m;

            db.prepare(
              `INSERT INTO assessment_revisions (
                 id, assessment_id, revision_number, changed_by, previous_total_score, new_total_score,
                 previous_scores_json, new_scores_json, reason
               ) VALUES (?, ?, ?, ?, NULL, ?, '{}', ?, 'Nộp phiếu chấm chính thức')`
            ).run(
              crypto.randomUUID(),
              assessmentId,
              maxRev + 1,
              user.id,
              calc.totalScore,
              JSON.stringify(calc.normalizedScores)
            );

            writeAuditLog(db, {
              actorId: user.id,
              actorUsername: user.username,
              action: 'ASSESSMENT_SUBMITTED',
              entityType: 'assessment',
              entityId: assessmentId,
              roomId,
              details: { groupId, groupName: group.name, totalScore: calc.totalScore },
              req,
            });

            return {
              id: assessmentId,
              status: 'SUBMITTED' as AssessmentStatus,
              totalScore: calc.totalScore,
              version: nextVersion,
              deduplicated: false,
            };
          })
          .immediate();

        realtime.broadcast(roomId, 'assessment:updated', {
          groupId,
          graderId: user.id,
          status: 'SUBMITTED',
        });

        res.json({ assessment: result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Lỗi nộp phiếu chấm.';
        if (msg.startsWith('ALREADY_SUBMITTED:')) {
          res.status(409).json({ error: msg.replace('ALREADY_SUBMITTED:', '') });
        } else {
          res.status(400).json({ error: msg });
        }
      }
    }
  );

  // Post-submission score correction with mandatory audit revision
  router.post(
    '/rooms/:roomId/assessments/:assessmentId/correct',
    requireRole('SUPER_ADMIN', 'TEACHER', 'GRADER'),
    (req: AuthedRequest, res) => {
      const { roomId, assessmentId } = req.params;
      const user = req.user!;
      const reason = sanitizeText(req.body?.reason, 500);

      if (reason.length < 4) {
        res.status(400).json({ error: 'Vui lòng nhập lý do hiệu chỉnh điểm (tối thiểu 4 ký tự).' });
        return;
      }

      const existing = db
        .prepare('SELECT * FROM assessments WHERE id = ? AND room_id = ?')
        .get(assessmentId, roomId) as
        | {
            id: string;
            room_id: string;
            group_id: string;
            grader_id: string;
            status: AssessmentStatus;
            total_score: number;
            version: number;
          }
        | undefined;

      if (!existing) {
        res.status(404).json({ error: 'Không tìm thấy phiếu chấm.' });
        return;
      }

      // Graders can ONLY modify their own assessment!
      if (user.role === 'GRADER' && existing.grader_id !== user.id) {
        res.status(403).json({ error: 'Giám khảo không thể sửa phiếu chấm của giám khảo khác.' });
        return;
      }

      const room = db.prepare('SELECT status FROM rooms WHERE id = ?').get(roomId) as {
        status: RoomStatus;
      };
      if (room.status === 'FINALIZED' || room.status === 'ARCHIVED') {
        res.status(400).json({
          error: 'Phòng đã chốt kết quả. Giáo viên cần mở lại phiên trước khi hiệu chỉnh điểm.',
        });
        return;
      }

      const { rubric, criteria } = getRoomRubricAndCriteria(db, roomId);
      if (!rubric) {
        res.status(400).json({ error: 'Không tìm thấy thang điểm.' });
        return;
      }

      const rawScores = Array.isArray(req.body?.scores) ? req.body.scores : [];
      const scoreInputs = rawScores.map(
        (s: { criterionId: string; score: unknown; comment?: unknown }) => ({
          criterionId: String(s.criterionId ?? ''),
          score: Number(s.score),
          comment: sanitizeText(s.comment, 500),
        })
      );

      const calc = validateAndCalculateTotal(criteria, scoreInputs, {
        scoringMode: rubric.scoring_mode,
        decimalPrecision: rubric.decimal_precision,
        requireAllCriteria: true,
      });

      if (!calc.valid) {
        res.status(400).json({ error: calc.errors[0], errors: calc.errors });
        return;
      }

      const prevScoreRows = db
        .prepare('SELECT criterion_id, score FROM assessment_scores WHERE assessment_id = ?')
        .all(assessmentId) as Array<{ criterion_id: string; score: number }>;
      const prevScoresMap: Record<string, number> = {};
      for (const r of prevScoreRows) {
        prevScoresMap[r.criterion_id] = r.score;
      }

      const updated = db
        .transaction(() => {
          const maxRev = (
            db
              .prepare('SELECT COALESCE(MAX(revision_number), 0) as m FROM assessment_revisions WHERE assessment_id = ?')
              .get(assessmentId) as { m: number }
          ).m;

          db.prepare(
            `INSERT INTO assessment_revisions (
               id, assessment_id, revision_number, changed_by, previous_total_score, new_total_score,
               previous_scores_json, new_scores_json, reason
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            crypto.randomUUID(),
            assessmentId,
            maxRev + 1,
            user.id,
            existing.total_score,
            calc.totalScore,
            JSON.stringify(prevScoresMap),
            JSON.stringify(calc.normalizedScores),
            reason
          );

          const nextVersion = existing.version + 1;
          db.prepare(
            `UPDATE assessments SET total_score = ?, version = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(calc.totalScore, nextVersion, assessmentId);

          db.prepare('DELETE FROM assessment_scores WHERE assessment_id = ?').run(assessmentId);
          const insertScore = db.prepare(
            `INSERT INTO assessment_scores (id, assessment_id, criterion_id, score, comment)
             VALUES (?, ?, ?, ?, ?)`
          );
          for (const item of scoreInputs) {
            insertScore.run(
              crypto.randomUUID(),
              assessmentId,
              item.criterionId,
              calc.normalizedScores[item.criterionId],
              item.comment
            );
          }

          if (req.body?.comments) {
            const c = req.body.comments;
            db.prepare(
              `UPDATE assessment_comments
               SET overall_comment = COALESCE(?, overall_comment),
                   strengths = COALESCE(?, strengths),
                   weaknesses = COALESCE(?, weaknesses),
                   suggestions = COALESCE(?, suggestions),
                   public_feedback = COALESCE(?, public_feedback),
                   private_notes = COALESCE(?, private_notes),
                   updated_at = datetime('now')
               WHERE assessment_id = ?`
            ).run(
              c.overallComment !== undefined ? sanitizeText(c.overallComment, 3000) : null,
              c.strengths !== undefined ? sanitizeText(c.strengths, 2000) : null,
              c.weaknesses !== undefined ? sanitizeText(c.weaknesses, 2000) : null,
              c.suggestions !== undefined ? sanitizeText(c.suggestions, 2000) : null,
              c.publicFeedback !== undefined ? sanitizeText(c.publicFeedback, 3000) : null,
              c.privateNotes !== undefined ? sanitizeText(c.privateNotes, 3000) : null,
              assessmentId
            );
          }

          writeAuditLog(db, {
            actorId: user.id,
            actorUsername: user.username,
            action: 'ASSESSMENT_CORRECTED',
            entityType: 'assessment',
            entityId: assessmentId,
            roomId,
            details: {
              groupId: existing.group_id,
              previousTotal: existing.total_score,
              newTotal: calc.totalScore,
              reason,
            },
            req,
          });

          return { totalScore: calc.totalScore, version: nextVersion };
        })
        .immediate();

      realtime.broadcast(roomId, 'assessment:updated', {
        groupId: existing.group_id,
        assessmentId,
        corrected: true,
      });

      res.json({ ok: true, ...updated });
    }
  );

  // Teacher review/lock individual assessment
  router.post(
    '/rooms/:roomId/assessments/:assessmentId/review',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    (req: AuthedRequest, res) => {
      const { roomId, assessmentId } = req.params;
      const targetStatus = req.body?.status as AssessmentStatus;

      const existing = db
        .prepare('SELECT id, status, group_id FROM assessments WHERE id = ? AND room_id = ?')
        .get(assessmentId, roomId) as { id: string; status: AssessmentStatus; group_id: string } | undefined;

      if (!existing) {
        res.status(404).json({ error: 'Không tìm thấy phiếu chấm.' });
        return;
      }
      if (!isValidAssessmentTransition(existing.status, targetStatus)) {
        res.status(400).json({ error: 'Chuyển trạng thái phiếu chấm không hợp lệ.' });
        return;
      }

      db.prepare(`UPDATE assessments SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
        targetStatus,
        assessmentId
      );

      realtime.broadcast(roomId, 'assessment:updated', {
        groupId: existing.group_id,
        status: targetStatus,
      });

      res.json({ ok: true });
    }
  );

  // Authoritative results & analytics (strictly filters private notes and unpublished results for students)
  router.get('/rooms/:roomId/results', requireAuth, (req: AuthedRequest, res) => {
    const { roomId } = req.params;
    const user = req.user!;

    if (!canAccessRoom(db, user, roomId)) {
      res.status(403).json({ error: 'Bạn không thuộc phòng thuyết trình này.' });
      return;
    }

    const isStudent = user.role === 'STUDENT';
    const payload = buildResultsPayload(db, roomId, !isStudent);
    if (!payload) {
      res.status(404).json({ error: 'Không tìm thấy phòng thuyết trình.' });
      return;
    }

    if (isStudent && payload.room.publish_results !== 1) {
      res.json({
        published: false,
        room: payload.room,
        rubric: payload.rubric,
        criteria: payload.criteria,
        summary: payload.summary,
        rankings: [],
        groupDetails: [],
      });
      return;
    }

    if (isStudent && payload.room.publish_feedback !== 1) {
      payload.groupDetails = payload.groupDetails.map((g) => ({
        ...g,
        graderAssessments: g.graderAssessments.map((ga) => ({
          ...ga,
          overallComment: '',
          strengths: '',
          weaknesses: '',
          suggestions: '',
          publicFeedback: '',
        })),
      }));
    }

    res.json({ published: true, ...payload });
  });

  // Export results (.xlsx, .csv, .pdf)
  router.get(
    '/rooms/:roomId/export',
    requireRole('SUPER_ADMIN', 'TEACHER', 'GRADER'),
    async (req: AuthedRequest, res) => {
      const { roomId } = req.params;
      const format = String(req.query.format || 'xlsx').toLowerCase();

      const payload = buildResultsPayload(db, roomId, true);
      if (!payload || !payload.rubric) {
        res.status(404).json({ error: 'Không tìm thấy dữ liệu phòng để xuất báo cáo.' });
        return;
      }

      const ctx: ExportRoomContext = {
        classroomName: payload.room.classroom_name,
        roomName: payload.room.name,
        roomCode: payload.room.room_code,
        sessionDate: payload.room.session_date,
        scoringMode: payload.rubric.scoring_mode,
        multiGraderPolicy: payload.room.multi_grader_policy,
        maxTotalScore: payload.rubric.max_total_score,
        criteria: payload.criteria,
        rankings: payload.rankings,
        groupDetails: payload.groupDetails,
      };

      writeAuditLog(db, {
        actorId: req.user!.id,
        actorUsername: req.user!.username,
        action: 'RESULTS_EXPORTED',
        entityType: 'room',
        entityId: roomId,
        roomId,
        details: { format },
        req,
      });

      const safeCode = payload.room.room_code.replace(/[^a-zA-Z0-9_-]/g, '_');

      if (format === 'csv') {
        const csv = generateCsvString(ctx);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="ket-qua-${safeCode}.csv"`);
        res.send(csv);
        return;
      }

      if (format === 'pdf') {
        const pdfBuffer = await generatePdfBuffer(ctx);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="ket-qua-${safeCode}.pdf"`);
        res.send(pdfBuffer);
        return;
      }

      const xlsxBuffer = await generateXlsxBuffer(ctx);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="ket-qua-${safeCode}.xlsx"`);
      res.send(xlsxBuffer);
    }
  );

  return router;
}
