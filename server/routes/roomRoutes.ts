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
  sanitizeUsername,
  SlidingWindowRateLimiter,
} from '../security.ts';
import {
  aggregateAndRankGroups,
  computeMaxPossibleScore,
  distributeStudentsEvenly,
  isValidRoomTransition,
  type AssessmentStatus,
  type MultiGraderPolicy,
  type RoomStatus,
  type RubricCriterionDef,
  type ScoringMode,
} from '../../src/lib/domain.ts';

export function createRoomRouter(db: DB, realtime: RealtimeHub) {
  const router = Router();
  const joinCodeLimiter = new SlidingWindowRateLimiter(5 * 60 * 1000, 20);
  const groupJoinLimiter = new SlidingWindowRateLimiter(60 * 1000, 30);

  // List accessible rooms
  router.get('/rooms', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    let rooms: unknown[];

    if (user.role === 'SUPER_ADMIN' || user.role === 'TEACHER') {
      rooms = db
        .prepare(
          `SELECT r.*, c.name as classroom_name, c.code as classroom_code,
                  (SELECT COUNT(*) FROM groups g WHERE g.room_id = r.id) as group_count,
                  (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id AND rm.room_role = 'STUDENT') as student_count,
                  (SELECT COUNT(DISTINCT a.group_id) FROM assessments a WHERE a.room_id = r.id AND a.status IN ('SUBMITTED', 'REVIEWED', 'FINALIZED')) as scored_group_count
           FROM rooms r
           JOIN classrooms c ON c.id = r.classroom_id
           ORDER BY r.created_at DESC`
        )
        .all();
    } else {
      rooms = db
        .prepare(
          `SELECT r.*, c.name as classroom_name, c.code as classroom_code,
                  (SELECT COUNT(*) FROM groups g WHERE g.room_id = r.id) as group_count,
                  (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id AND rm2.room_role = 'STUDENT') as student_count,
                  (SELECT COUNT(DISTINCT a.group_id) FROM assessments a WHERE a.room_id = r.id AND a.status IN ('SUBMITTED', 'REVIEWED', 'FINALIZED')) as scored_group_count
           FROM rooms r
           JOIN classrooms c ON c.id = r.classroom_id
           JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
           WHERE r.status <> 'ARCHIVED'
           ORDER BY r.created_at DESC`
        )
        .all(user.id);
    }

    res.json({ rooms });
  });

  // Student or Grader joins a room using unique room code
  router.post(
    '/rooms/join-by-code',
    requireAuth,
    rateLimitMiddleware(joinCodeLimiter, (req: AuthedRequest) => req.user!.id),
    (req: AuthedRequest, res) => {
      const code = sanitizeUsername(req.body?.roomCode).toUpperCase();
      if (!code) {
        res.status(400).json({ error: 'Vui lòng nhập mã phòng thuyết trình.' });
        return;
      }

      const room = db
        .prepare(`SELECT id, name, status FROM rooms WHERE room_code = ?`)
        .get(code) as { id: string; name: string; status: RoomStatus } | undefined;

      if (!room || room.status === 'DRAFT' || room.status === 'ARCHIVED') {
        res.status(404).json({ error: 'Không tìm thấy phòng thuyết trình phù hợp hoặc phòng chưa mở.' });
        return;
      }

      const roleInRoom = req.user!.role === 'STUDENT' ? 'STUDENT' : req.user!.role === 'GRADER' ? 'GRADER' : 'TEACHER';

      db.transaction(() => {
        db.prepare(
          `INSERT OR IGNORE INTO room_members (id, room_id, user_id, room_role, grader_weight)
           VALUES (?, ?, ?, ?, 1.0)`
        ).run(crypto.randomUUID(), room.id, req.user!.id, roleInRoom);

        writeAuditLog(db, {
          actorId: req.user!.id,
          actorUsername: req.user!.username,
          action: 'ROOM_JOINED_BY_CODE',
          entityType: 'room',
          entityId: room.id,
          roomId: room.id,
          details: { roomCode: code },
          req,
        });
      })();

      res.json({ roomId: room.id, name: room.name });
    }
  );

  // Create new presentation room with default groups & rubric
  router.post('/rooms', requireRole('SUPER_ADMIN', 'TEACHER'), (req: AuthedRequest, res) => {
    const classroomId = typeof req.body?.classroomId === 'string' ? req.body.classroomId : '';
    const name = sanitizeText(req.body?.name, 140);
    const description = sanitizeText(req.body?.description, 600);
    const sessionDate = sanitizeText(req.body?.sessionDate || new Date().toISOString().slice(0, 10), 20);
    const requestedCode = sanitizeUsername(req.body?.roomCode).toUpperCase();
    const roomCode = requestedCode || `12A17-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const groupCount = Math.min(24, Math.max(1, Number(req.body?.groupCount) || 8));
    const groupCapacity = Math.min(50, Math.max(1, Number(req.body?.groupCapacity) || 6));
    const allowStudentSelection = req.body?.allowStudentSelection !== false;
    const autoEnrollStudents = req.body?.autoEnrollStudents !== false;

    if (!classroomId || !name) {
      res.status(400).json({ error: 'Vui lòng chọn lớp học và nhập tên phòng thuyết trình.' });
      return;
    }

    const classroom = db.prepare('SELECT id FROM classrooms WHERE id = ?').get(classroomId);
    if (!classroom) {
      res.status(404).json({ error: 'Lớp học không tồn tại.' });
      return;
    }

    const codeExists = db.prepare('SELECT id FROM rooms WHERE room_code = ?').get(roomCode);
    if (codeExists) {
      res.status(409).json({ error: `Mã phòng "${roomCode}" đã được sử dụng.` });
      return;
    }

    const roomId = `room_${crypto.randomUUID().slice(0, 8)}`;
    const rubricId = `rub_${crypto.randomUUID().slice(0, 8)}`;

    db.transaction(() => {
      db.prepare(
        `INSERT INTO rooms (
           id, classroom_id, name, room_code, description, session_date, status,
           allow_student_selection, require_admin_approval, lock_groups_on_start,
           multi_grader_policy, publish_results, publish_feedback, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, 0, 1, 'AVERAGE', 0, 1, ?)`
      ).run(roomId, classroomId, name, roomCode, description, sessionDate, allowStudentSelection ? 1 : 0, req.user!.id);

      // Enroll teachers/graders from classroom
      const staff = db
        .prepare(
          `SELECT user_id, member_role FROM classroom_members
           WHERE classroom_id = ? AND member_role IN ('TEACHER', 'GRADER')`
        )
        .all(classroomId) as Array<{ user_id: string; member_role: string }>;

      const insertMember = db.prepare(
        `INSERT OR IGNORE INTO room_members (id, room_id, user_id, room_role, grader_weight)
         VALUES (?, ?, ?, ?, 1.0)`
      );
      insertMember.run(crypto.randomUUID(), roomId, req.user!.id, 'TEACHER');
      for (const s of staff) {
        insertMember.run(crypto.randomUUID(), roomId, s.user_id, s.member_role);
      }

      if (autoEnrollStudents) {
        const students = db
          .prepare(
            `SELECT cm.user_id FROM classroom_members cm
             JOIN users u ON u.id = cm.user_id
             WHERE cm.classroom_id = ? AND cm.member_role = 'STUDENT' AND u.is_active = 1`
          )
          .all(classroomId) as Array<{ user_id: string }>;
        for (const st of students) {
          insertMember.run(crypto.randomUUID(), roomId, st.user_id, 'STUDENT');
        }
      }

      // Create default groups
      const insertGroup = db.prepare(
        `INSERT INTO groups (id, room_id, name, description, max_capacity, presentation_order)
         VALUES (?, ?, ?, '', ?, ?)`
      );
      for (let i = 1; i <= groupCount; i++) {
        insertGroup.run(`grp_${crypto.randomUUID().slice(0, 8)}`, roomId, `Nhóm ${i}`, groupCapacity, i);
      }

      // Create default 10-point rubric
      db.prepare(
        `INSERT INTO scoring_rubrics (id, room_id, title, scoring_mode, decimal_precision, max_total_score)
         VALUES (?, ?, 'Rubric Thuyết trình Thang điểm 10', 'SUM', 2, 10)`
      ).run(rubricId, roomId);

      const defaults = [
        ['Nội dung và kiến thức', 'Độ chính xác chuyên môn và lập luận', 0, 2, 2, 1],
        ['Cấu trúc bài thuyết trình', 'Bố cục rõ ràng, quản lý thời gian tốt', 0, 2, 2, 2],
        ['Kỹ năng trình bày', 'Trình bày tự tin, tương tác với lớp', 0, 2, 2, 3],
        ['Thiết kế slide', 'Slide trực quan, chữ rõ ràng dễ nhìn', 0, 1.5, 1.5, 4],
        ['Làm việc nhóm', 'Phối hợp đồng đều giữa các thành viên', 0, 1.5, 1.5, 5],
        ['Trả lời câu hỏi', 'Xử lý câu hỏi thuyết phục, chính xác', 0, 1, 1, 6],
      ] as const;

      const insertCrit = db.prepare(
        `INSERT INTO rubric_criteria (id, rubric_id, name, description, min_score, max_score, weight, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const [cName, cDesc, minS, maxS, w, order] of defaults) {
        insertCrit.run(`crit_${crypto.randomUUID().slice(0, 8)}`, rubricId, cName, cDesc, minS, maxS, w, order);
      }

      writeAuditLog(db, {
        actorId: req.user!.id,
        actorUsername: req.user!.username,
        action: 'ROOM_CREATED',
        entityType: 'room',
        entityId: roomId,
        roomId,
        details: { name, roomCode, groupCount, groupCapacity },
        req,
      });
    })();

    res.status(201).json({ room: db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) });
  });

  // Full room workspace payload
  router.get('/rooms/:roomId', requireAuth, (req: AuthedRequest, res) => {
    const { roomId } = req.params;
    const user = req.user!;

    if (!canAccessRoom(db, user, roomId)) {
      res.status(403).json({ error: 'Bạn không thuộc phòng thuyết trình này.' });
      return;
    }

    const room = db
      .prepare(
        `SELECT r.*, c.name as classroom_name, c.code as classroom_code
         FROM rooms r
         JOIN classrooms c ON c.id = r.classroom_id
         WHERE r.id = ?`
      )
      .get(roomId);

    if (!room) {
      res.status(404).json({ error: 'Không tìm thấy phòng thuyết trình.' });
      return;
    }

    const groups = db
      .prepare(
        `SELECT g.*, p.full_name as leader_name
         FROM groups g
         LEFT JOIN profiles p ON p.user_id = g.leader_user_id
         WHERE g.room_id = ?
         ORDER BY g.presentation_order ASC, g.name ASC`
      )
      .all(roomId) as Array<{
      id: string;
      room_id: string;
      name: string;
      description: string;
      max_capacity: number;
      presentation_order: number;
      leader_user_id: string | null;
      leader_name: string | null;
      is_locked: number;
    }>;

    const groupMembers = db
      .prepare(
        `SELECT gm.id, gm.group_id, gm.user_id, gm.approval_status, gm.joined_at,
                u.username, p.full_name, p.student_code
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
         LEFT JOIN profiles p ON p.user_id = gm.user_id
         WHERE gm.room_id = ?
         ORDER BY p.student_code ASC, u.username ASC`
      )
      .all(roomId) as Array<{
      id: string;
      group_id: string;
      user_id: string;
      approval_status: string;
      joined_at: string;
      username: string;
      full_name: string | null;
      student_code: string | null;
    }>;

    const membersByGroup = new Map<string, typeof groupMembers>();
    for (const m of groupMembers) {
      if (!membersByGroup.has(m.group_id)) membersByGroup.set(m.group_id, []);
      membersByGroup.get(m.group_id)!.push(m);
    }

    const enrichedGroups = groups.map((g) => {
      const members = membersByGroup.get(g.id) ?? [];
      return {
        ...g,
        memberCount: members.length,
        remainingCapacity: Math.max(0, g.max_capacity - members.length),
        members,
      };
    });

    const assignedUserIds = new Set(groupMembers.map((m) => m.user_id));
    const roomStudents =
      user.role === 'STUDENT'
        ? []
        : db
            .prepare(
              `SELECT u.id as user_id, u.username, p.full_name, p.student_code
               FROM room_members rm
               JOIN users u ON u.id = rm.user_id
               LEFT JOIN profiles p ON p.user_id = u.id
               WHERE rm.room_id = ? AND rm.room_role = 'STUDENT' AND u.is_active = 1
               ORDER BY p.student_code ASC, u.username ASC`
            )
            .all(roomId);

    const unassignedStudents = (
      roomStudents as Array<{ user_id: string; username: string; full_name: string | null; student_code: string | null }>
    ).filter((s) => !assignedUserIds.has(s.user_id));

    const rubric = db.prepare('SELECT * FROM scoring_rubrics WHERE room_id = ?').get(roomId) as
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
      ? db
          .prepare('SELECT * FROM rubric_criteria WHERE rubric_id = ? ORDER BY sort_order ASC')
          .all(rubric.id)
      : [];

    const graders =
      user.role === 'STUDENT'
        ? []
        : db
            .prepare(
              `SELECT rm.user_id, rm.room_role, rm.grader_weight, u.username, p.full_name
               FROM room_members rm
               JOIN users u ON u.id = rm.user_id
               LEFT JOIN profiles p ON p.user_id = u.id
               WHERE rm.room_id = ? AND rm.room_role IN ('TEACHER', 'GRADER')`
            )
            .all(roomId);

    const myGroupMembership =
      groupMembers.find((m) => m.user_id === user.id) ?? null;

    res.json({
      room,
      groups: enrichedGroups,
      unassignedStudents,
      rubric,
      criteria,
      graders,
      myGroupMembership,
    });
  });

  // Update room configuration
  router.patch('/rooms/:roomId', requireRole('SUPER_ADMIN', 'TEACHER'), (req: AuthedRequest, res) => {
    const { roomId } = req.params;
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as
      | {
          id: string;
          name: string;
          description: string;
          session_date: string;
          allow_student_selection: number;
          require_admin_approval: number;
          lock_groups_on_start: number;
          multi_grader_policy: MultiGraderPolicy;
          publish_results: number;
          publish_feedback: number;
        }
      | undefined;

    if (!room) {
      res.status(404).json({ error: 'Không tìm thấy phòng thuyết trình.' });
      return;
    }

    const name = req.body?.name !== undefined ? sanitizeText(req.body.name, 140) : room.name;
    const description =
      req.body?.description !== undefined
        ? sanitizeText(req.body.description, 600)
        : room.description;
    const sessionDate =
      req.body?.sessionDate !== undefined ? sanitizeText(req.body.sessionDate, 20) : room.session_date;
    const allowStudentSelection =
      typeof req.body?.allowStudentSelection === 'boolean'
        ? req.body.allowStudentSelection
          ? 1
          : 0
        : room.allow_student_selection;
    const requireAdminApproval =
      typeof req.body?.requireAdminApproval === 'boolean'
        ? req.body.requireAdminApproval
          ? 1
          : 0
        : room.require_admin_approval;
    const lockGroupsOnStart =
      typeof req.body?.lockGroupsOnStart === 'boolean'
        ? req.body.lockGroupsOnStart
          ? 1
          : 0
        : room.lock_groups_on_start;
    const multiGraderPolicy =
      req.body?.multiGraderPolicy === 'AVERAGE' || req.body?.multiGraderPolicy === 'WEIGHTED_AVERAGE'
        ? req.body.multiGraderPolicy
        : room.multi_grader_policy;
    const publishResults =
      typeof req.body?.publishResults === 'boolean'
        ? req.body.publishResults
          ? 1
          : 0
        : room.publish_results;
    const publishFeedback =
      typeof req.body?.publishFeedback === 'boolean'
        ? req.body.publishFeedback
          ? 1
          : 0
        : room.publish_feedback;

    db.transaction(() => {
      db.prepare(
        `UPDATE rooms
         SET name = ?, description = ?, session_date = ?,
             allow_student_selection = ?, require_admin_approval = ?,
             lock_groups_on_start = ?, multi_grader_policy = ?,
             publish_results = ?, publish_feedback = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        name,
        description,
        sessionDate,
        allowStudentSelection,
        requireAdminApproval,
        lockGroupsOnStart,
        multiGraderPolicy,
        publishResults,
        publishFeedback,
        roomId
      );

      writeAuditLog(db, {
        actorId: req.user!.id,
        actorUsername: req.user!.username,
        action: 'ROOM_CONFIG_UPDATED',
        entityType: 'room',
        entityId: roomId,
        roomId,
        details: { publishResults, publishFeedback, allowStudentSelection, multiGraderPolicy },
        req,
      });
    })();

    realtime.broadcast(roomId, 'room:updated', { roomId });
    if (publishResults !== room.publish_results) {
      realtime.broadcast(roomId, 'results:published', { publishResults: publishResults === 1 });
    }

    res.json({ room: db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) });
  });

  // Room lifecycle state transitions
  router.post(
    '/rooms/:roomId/transition',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    (req: AuthedRequest, res) => {
      const { roomId } = req.params;
      const targetStatus = req.body?.targetStatus as RoomStatus;
      const reopenConfirmed = Boolean(req.body?.reopenConfirmed);
      const reason = sanitizeText(req.body?.reason, 300);

      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as
        | {
            id: string;
            status: RoomStatus;
            lock_groups_on_start: number;
            multi_grader_policy: MultiGraderPolicy;
          }
        | undefined;

      if (!room) {
        res.status(404).json({ error: 'Không tìm thấy phòng thuyết trình.' });
        return;
      }

      const check = isValidRoomTransition(room.status, targetStatus, { reopenConfirmed });
      if (!check.valid) {
        res.status(400).json({ error: check.reason });
        return;
      }

      db.transaction(() => {
        db.prepare(`UPDATE rooms SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
          targetStatus,
          roomId
        );

        if (targetStatus === 'IN_PROGRESS') {
          if (room.lock_groups_on_start === 1) {
            db.prepare(`UPDATE groups SET is_locked = 1, updated_at = datetime('now') WHERE room_id = ?`).run(
              roomId
            );
          }
          const activeSess = db
            .prepare(`SELECT id FROM assessment_sessions WHERE room_id = ? AND status = 'ACTIVE'`)
            .get(roomId);
          if (!activeSess) {
            db.prepare(
              `INSERT INTO assessment_sessions (id, room_id, status, started_by) VALUES (?, ?, 'ACTIVE', ?)`
            ).run(crypto.randomUUID(), roomId, req.user!.id);
          }
        } else if (targetStatus === 'PAUSED') {
          db.prepare(
            `UPDATE assessment_sessions SET status = 'PAUSED' WHERE room_id = ? AND status = 'ACTIVE'`
          ).run(roomId);
        } else if (targetStatus === 'FINALIZED') {
          db.prepare(
            `UPDATE assessment_sessions SET status = 'CLOSED', ended_at = datetime('now') WHERE room_id = ? AND status IN ('ACTIVE', 'PAUSED')`
          ).run(roomId);

          // Lock all submitted assessments and snapshot authoritative published_results
          db.prepare(
            `UPDATE assessments SET status = 'FINALIZED', updated_at = datetime('now')
             WHERE room_id = ? AND status IN ('SUBMITTED', 'REVIEWED')`
          ).run(roomId);

          db.prepare(`UPDATE rooms SET publish_results = 1, updated_at = datetime('now') WHERE id = ?`).run(
            roomId
          );

          const rubric = db
            .prepare('SELECT id, decimal_precision FROM scoring_rubrics WHERE room_id = ?')
            .get(roomId) as { id: string; decimal_precision: 0 | 1 | 2 } | undefined;

          const criteriaRows = rubric
            ? (db
                .prepare(
                  `SELECT id, name, min_score as minScore, max_score as maxScore, weight, sort_order as sortOrder
                   FROM rubric_criteria WHERE rubric_id = ? ORDER BY sort_order ASC`
                )
                .all(rubric.id) as RubricCriterionDef[])
            : [];

          const groups = db
            .prepare(
              `SELECT g.id as groupId, g.name as groupName, g.presentation_order as presentationOrder,
                      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) as memberCount
               FROM groups g WHERE g.room_id = ?`
            )
            .all(roomId) as Array<{
            groupId: string;
            groupName: string;
            presentationOrder: number;
            memberCount: number;
          }>;

          const assessments = db
            .prepare(
              `SELECT a.id as assessmentId, a.group_id, a.grader_id, a.status, a.total_score,
                      COALESCE(rm.grader_weight, 1.0) as graderWeight
               FROM assessments a
               LEFT JOIN room_members rm ON rm.room_id = a.room_id AND rm.user_id = a.grader_id
               WHERE a.room_id = ?`
            )
            .all(roomId) as Array<{
            assessmentId: string;
            group_id: string;
            grader_id: string;
            status: AssessmentStatus;
            total_score: number;
            graderWeight: number;
          }>;

          const scores = db
            .prepare(
              `SELECT s.assessment_id, s.criterion_id, s.score
               FROM assessment_scores s
               JOIN assessments a ON a.id = s.assessment_id
               WHERE a.room_id = ?`
            )
            .all(roomId) as Array<{ assessment_id: string; criterion_id: string; score: number }>;

          const scoreMap = new Map<string, Record<string, number>>();
          for (const sc of scores) {
            if (!scoreMap.has(sc.assessment_id)) scoreMap.set(sc.assessment_id, {});
            scoreMap.get(sc.assessment_id)![sc.criterion_id] = sc.score;
          }

          const ranked = aggregateAndRankGroups(
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
            criteriaRows,
            room.multi_grader_policy,
            rubric?.decimal_precision ?? 1
          );

          const upsertResult = db.prepare(
            `INSERT INTO published_results (id, room_id, group_id, final_score, rank, grader_count, criteria_breakdown_json, published_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(room_id, group_id) DO UPDATE SET
               final_score = excluded.final_score,
               rank = excluded.rank,
               grader_count = excluded.grader_count,
               criteria_breakdown_json = excluded.criteria_breakdown_json,
               published_at = datetime('now'),
               published_by = excluded.published_by`
          );

          for (const r of ranked) {
            upsertResult.run(
              crypto.randomUUID(),
              roomId,
              r.groupId,
              r.finalScore,
              r.rank,
              r.submittedGraderCount,
              JSON.stringify(r.criterionAverages),
              req.user!.id
            );
          }
        }

        writeAuditLog(db, {
          actorId: req.user!.id,
          actorUsername: req.user!.username,
          action: 'ROOM_STATUS_CHANGED',
          entityType: 'room',
          entityId: roomId,
          roomId,
          details: { from: room.status, to: targetStatus, reason },
          req,
        });
      })();

      realtime.broadcast(roomId, 'room:updated', { status: targetStatus });
      if (targetStatus === 'FINALIZED') {
        realtime.broadcast(roomId, 'results:published', { publishResults: true });
      }

      res.json({ room: db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) });
    }
  );

  // Configure N groups for a room
  router.post(
    '/rooms/:roomId/groups/configure',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    (req: AuthedRequest, res) => {
      const { roomId } = req.params;
      const groupCount = Math.min(24, Math.max(1, Number(req.body?.groupCount) || 8));
      const defaultCapacity = Math.min(50, Math.max(1, Number(req.body?.defaultCapacity) || 6));

      const room = db.prepare('SELECT id, status FROM rooms WHERE id = ?').get(roomId) as
        | { id: string; status: RoomStatus }
        | undefined;
      if (!room) {
        res.status(404).json({ error: 'Không tìm thấy phòng.' });
        return;
      }

      const existingGroups = db
        .prepare('SELECT id, name, max_capacity, presentation_order FROM groups WHERE room_id = ? ORDER BY presentation_order ASC')
        .all(roomId) as Array<{ id: string; name: string; max_capacity: number; presentation_order: number }>;

      db.transaction(() => {
        if (groupCount > existingGroups.length) {
          const insert = db.prepare(
            `INSERT INTO groups (id, room_id, name, description, max_capacity, presentation_order)
             VALUES (?, ?, ?, '', ?, ?)`
          );
          for (let i = existingGroups.length + 1; i <= groupCount; i++) {
            insert.run(`grp_${crypto.randomUUID().slice(0, 8)}`, roomId, `Nhóm ${i}`, defaultCapacity, i);
          }
        } else if (groupCount < existingGroups.length) {
          const toRemove = existingGroups.slice(groupCount);
          for (const g of toRemove) {
            const assessed = db
              .prepare('SELECT 1 FROM assessments WHERE group_id = ? LIMIT 1')
              .get(g.id);
            if (assessed) {
              throw new Error(`Không thể xóa "${g.name}" vì đã có dữ liệu chấm điểm.`);
            }
            db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
          }
        }

        // Update capacity on remaining groups if requested
        if (req.body?.applyCapacityToAll) {
          db.prepare(`UPDATE groups SET max_capacity = ?, updated_at = datetime('now') WHERE room_id = ?`).run(
            defaultCapacity,
            roomId
          );
        }

        writeAuditLog(db, {
          actorId: req.user!.id,
          actorUsername: req.user!.username,
          action: 'GROUPS_CONFIGURED',
          entityType: 'room',
          entityId: roomId,
          roomId,
          details: { groupCount, defaultCapacity },
          req,
        });
      })();

      realtime.broadcast(roomId, 'group:updated', { roomId });
      res.json({ ok: true });
    }
  );

  // Smart automatic group distribution
  router.post(
    '/rooms/:roomId/groups/auto-distribute',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    (req: AuthedRequest, res) => {
      const { roomId } = req.params;
      const preserveExisting = Boolean(req.body?.preserveExisting);

      const students = db
        .prepare(
          `SELECT rm.user_id
           FROM room_members rm
           JOIN users u ON u.id = rm.user_id
           LEFT JOIN profiles p ON p.user_id = u.id
           WHERE rm.room_id = ? AND rm.room_role = 'STUDENT' AND u.is_active = 1
           ORDER BY p.student_code ASC, u.username ASC`
        )
        .all(roomId) as Array<{ user_id: string }>;

      const groups = db
        .prepare(
          `SELECT id, name, max_capacity as maxCapacity FROM groups WHERE room_id = ? ORDER BY presentation_order ASC`
        )
        .all(roomId) as Array<{ id: string; name: string; maxCapacity: number }>;

      if (groups.length === 0) {
        res.status(400).json({ error: 'Phòng chưa có nhóm nào để phân chia.' });
        return;
      }

      const existingRows = db
        .prepare('SELECT group_id, user_id FROM group_members WHERE room_id = ?')
        .all(roomId) as Array<{ group_id: string; user_id: string }>;

      const existingMap = new Map<string, string[]>();
      for (const r of existingRows) {
        if (!existingMap.has(r.group_id)) existingMap.set(r.group_id, []);
        existingMap.get(r.group_id)!.push(r.user_id);
      }

      const result = distributeStudentsEvenly(
        students.map((s) => s.user_id),
        groups.map((g) => ({
          id: g.id,
          name: g.name,
          maxCapacity: g.maxCapacity,
          existingStudentIds: existingMap.get(g.id) ?? [],
        })),
        { preserveExisting }
      );

      db.transaction(() => {
        db.prepare('DELETE FROM group_members WHERE room_id = ?').run(roomId);
        const insert = db.prepare(
          `INSERT INTO group_members (id, room_id, group_id, user_id, approval_status, assigned_by)
           VALUES (?, ?, ?, ?, 'APPROVED', ?)`
        );
        for (const [groupId, memberIds] of Object.entries(result.assignments)) {
          for (const uid of memberIds) {
            insert.run(crypto.randomUUID(), roomId, groupId, uid, req.user!.id);
          }
          // Ensure leader is assigned if empty or no longer in group
          const currentGroup = db
            .prepare('SELECT leader_user_id FROM groups WHERE id = ?')
            .get(groupId) as { leader_user_id: string | null } | undefined;
          if (!currentGroup?.leader_user_id || !memberIds.includes(currentGroup.leader_user_id)) {
            db.prepare('UPDATE groups SET leader_user_id = ? WHERE id = ?').run(
              memberIds[0] ?? null,
              groupId
            );
          }
        }

        writeAuditLog(db, {
          actorId: req.user!.id,
          actorUsername: req.user!.username,
          action: 'GROUPS_AUTO_DISTRIBUTED',
          entityType: 'room',
          entityId: roomId,
          roomId,
          details: {
            preserveExisting,
            totalStudents: students.length,
            unassignedCount: result.unassignedStudentIds.length,
          },
          req,
        });
      })();

      realtime.broadcast(roomId, 'group:updated', { roomId });
      res.json({
        assignedTotal: students.length - result.unassignedStudentIds.length,
        unassignedCount: result.unassignedStudentIds.length,
        counts: result.counts,
      });
    }
  );

  // Update group details (name, description, capacity, presentation order, leader, lock)
  router.patch(
    '/rooms/:roomId/groups/:groupId',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    (req: AuthedRequest, res) => {
      const { roomId, groupId } = req.params;
      const group = db
        .prepare('SELECT * FROM groups WHERE id = ? AND room_id = ?')
        .get(groupId, roomId) as
        | {
            id: string;
            name: string;
            description: string;
            max_capacity: number;
            presentation_order: number;
            leader_user_id: string | null;
            is_locked: number;
          }
        | undefined;

      if (!group) {
        res.status(404).json({ error: 'Không tìm thấy nhóm.' });
        return;
      }

      const name = req.body?.name !== undefined ? sanitizeText(req.body.name, 80) : group.name;
      const description =
        req.body?.description !== undefined
          ? sanitizeText(req.body.description, 400)
          : group.description;
      const maxCapacity =
        req.body?.maxCapacity !== undefined
          ? Math.min(100, Math.max(1, Number(req.body.maxCapacity)))
          : group.max_capacity;
      const presentationOrder =
        req.body?.presentationOrder !== undefined
          ? Math.max(1, Number(req.body.presentationOrder))
          : group.presentation_order;
      const leaderUserId =
        req.body?.leaderUserId !== undefined ? req.body.leaderUserId || null : group.leader_user_id;
      const isLocked =
        typeof req.body?.isLocked === 'boolean' ? (req.body.isLocked ? 1 : 0) : group.is_locked;

      const currentMembers = (
        db.prepare('SELECT COUNT(*) as c FROM group_members WHERE group_id = ?').get(groupId) as {
          c: number;
        }
      ).c;
      if (maxCapacity < currentMembers) {
        res.status(400).json({
          error: `Không thể đặt sức chứa (${maxCapacity}) nhỏ hơn số thành viên hiện tại (${currentMembers}).`,
        });
        return;
      }

      db.prepare(
        `UPDATE groups
         SET name = ?, description = ?, max_capacity = ?, presentation_order = ?, leader_user_id = ?, is_locked = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(name, description, maxCapacity, presentationOrder, leaderUserId, isLocked, groupId);

      writeAuditLog(db, {
        actorId: req.user!.id,
        actorUsername: req.user!.username,
        action: 'GROUP_UPDATED',
        entityType: 'group',
        entityId: groupId,
        roomId,
        details: { name, maxCapacity, presentationOrder, isLocked },
        req,
      });

      realtime.broadcast(roomId, 'group:updated', { groupId });
      res.json({ group: db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId) });
    }
  );

  // Atomic student self-selection join (prevents race conditions on last seat!)
  router.post(
    '/rooms/:roomId/groups/:groupId/join',
    requireRole('STUDENT'),
    rateLimitMiddleware(groupJoinLimiter, (req: AuthedRequest) => req.user!.id),
    (req: AuthedRequest, res) => {
      const { roomId, groupId } = req.params;
      const userId = req.user!.id;

      if (!canAccessRoom(db, req.user!, roomId)) {
        res.status(403).json({ error: 'Bạn không thuộc phòng thuyết trình này.' });
        return;
      }

      try {
        const joinTx = db.transaction(() => {
          const room = db
            .prepare(
              `SELECT status, allow_student_selection, require_admin_approval FROM rooms WHERE id = ?`
            )
            .get(roomId) as
            | {
                status: RoomStatus;
                allow_student_selection: number;
                require_admin_approval: number;
              }
            | undefined;

          if (!room) {
            throw new Error('NOT_FOUND:Không tìm thấy phòng thuyết trình.');
          }
          if (room.status !== 'REGISTRATION_OPEN' || room.allow_student_selection !== 1) {
            throw new Error('FORBIDDEN:Phòng hiện không mở cho sinh viên tự chọn nhóm.');
          }

          const group = db
            .prepare(`SELECT id, name, max_capacity, is_locked FROM groups WHERE id = ? AND room_id = ?`)
            .get(groupId, roomId) as
            | { id: string; name: string; max_capacity: number; is_locked: number }
            | undefined;

          if (!group) {
            throw new Error('NOT_FOUND:Không tìm thấy nhóm.');
          }
          if (group.is_locked === 1) {
            throw new Error('FORBIDDEN:Nhóm này đã bị khóa thay đổi thành viên.');
          }

          const currentMembership = db
            .prepare('SELECT group_id FROM group_members WHERE room_id = ? AND user_id = ?')
            .get(roomId, userId) as { group_id: string } | undefined;

          if (currentMembership?.group_id === groupId) {
            return { alreadyInGroup: true, groupName: group.name };
          }

          const memberCount = (
            db.prepare('SELECT COUNT(*) as c FROM group_members WHERE group_id = ?').get(groupId) as {
              c: number;
            }
          ).c;

          if (memberCount >= group.max_capacity) {
            throw new Error(`FULL:${group.name} đã đủ ${group.max_capacity} thành viên.`);
          }

          db.prepare('DELETE FROM group_members WHERE room_id = ? AND user_id = ?').run(roomId, userId);

          const approvalStatus = room.require_admin_approval === 1 ? 'PENDING' : 'APPROVED';
          db.prepare(
            `INSERT INTO group_members (id, room_id, group_id, user_id, approval_status)
             VALUES (?, ?, ?, ?, ?)`
          ).run(crypto.randomUUID(), roomId, groupId, userId, approvalStatus);

          writeAuditLog(db, {
            actorId: userId,
            actorUsername: req.user!.username,
            action: 'STUDENT_JOINED_GROUP',
            entityType: 'group',
            entityId: groupId,
            roomId,
            details: { groupName: group.name, approvalStatus },
            req,
          });

          return { alreadyInGroup: false, groupName: group.name, approvalStatus };
        });

        // BEGIN IMMEDIATE acquires write lock before reading count — serializing concurrent last-seat requests
        const outcome = joinTx.immediate();
        realtime.broadcast(roomId, 'group:updated', { groupId, userId });
        res.json({ ok: true, ...outcome });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Lỗi chọn nhóm.';
        if (msg.startsWith('NOT_FOUND:')) {
          res.status(404).json({ error: msg.replace('NOT_FOUND:', '') });
        } else if (msg.startsWith('FORBIDDEN:')) {
          res.status(403).json({ error: msg.replace('FORBIDDEN:', '') });
        } else if (msg.startsWith('FULL:')) {
          res.status(409).json({ error: msg.replace('FULL:', '') });
        } else {
          res.status(400).json({ error: msg });
        }
      }
    }
  );

  // Admin manual assign/move student
  router.post(
    '/rooms/:roomId/groups/:groupId/assign',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    (req: AuthedRequest, res) => {
      const { roomId, groupId } = req.params;
      const targetUserId = typeof req.body?.userId === 'string' ? req.body.userId : '';
      const reason = sanitizeText(req.body?.reason, 200);

      if (!targetUserId) {
        res.status(400).json({ error: 'Thiếu mã học sinh cần phân nhóm.' });
        return;
      }

      try {
        db.transaction(() => {
          const group = db
            .prepare('SELECT id, name, max_capacity FROM groups WHERE id = ? AND room_id = ?')
            .get(groupId, roomId) as { id: string; name: string; max_capacity: number } | undefined;
          if (!group) throw new Error('NOT_FOUND:Không tìm thấy nhóm.');

          const current = db
            .prepare('SELECT group_id FROM group_members WHERE room_id = ? AND user_id = ?')
            .get(roomId, targetUserId) as { group_id: string } | undefined;
          if (current?.group_id === groupId) return;

          const count = (
            db.prepare('SELECT COUNT(*) as c FROM group_members WHERE group_id = ?').get(groupId) as {
              c: number;
            }
          ).c;
          if (count >= group.max_capacity) {
            throw new Error(`FULL:${group.name} đã đạt giới hạn ${group.max_capacity} thành viên.`);
          }

          db.prepare('INSERT OR IGNORE INTO room_members (id, room_id, user_id, room_role) VALUES (?, ?, ?, \'STUDENT\')').run(
            crypto.randomUUID(),
            roomId,
            targetUserId
          );

          db.prepare('DELETE FROM group_members WHERE room_id = ? AND user_id = ?').run(roomId, targetUserId);
          db.prepare(
            `INSERT INTO group_members (id, room_id, group_id, user_id, approval_status, assigned_by)
             VALUES (?, ?, ?, ?, 'APPROVED', ?)`
          ).run(crypto.randomUUID(), roomId, groupId, targetUserId, req.user!.id);

          writeAuditLog(db, {
            actorId: req.user!.id,
            actorUsername: req.user!.username,
            action: 'ADMIN_ASSIGNED_STUDENT',
            entityType: 'group',
            entityId: groupId,
            roomId,
            details: { targetUserId, previousGroupId: current?.group_id ?? null, reason },
            req,
          });
        }).immediate();

        realtime.broadcast(roomId, 'group:updated', { groupId });
        res.json({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Lỗi phân nhóm.';
        if (msg.startsWith('NOT_FOUND:')) res.status(404).json({ error: msg.replace('NOT_FOUND:', '') });
        else if (msg.startsWith('FULL:')) res.status(409).json({ error: msg.replace('FULL:', '') });
        else res.status(400).json({ error: msg });
      }
    }
  );

  // Admin remove student from group
  router.delete(
    '/rooms/:roomId/groups/:groupId/members/:userId',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    (req: AuthedRequest, res) => {
      const { roomId, groupId, userId } = req.params;
      db.transaction(() => {
        db.prepare('DELETE FROM group_members WHERE room_id = ? AND group_id = ? AND user_id = ?').run(
          roomId,
          groupId,
          userId
        );
        db.prepare('UPDATE groups SET leader_user_id = NULL WHERE id = ? AND leader_user_id = ?').run(
          groupId,
          userId
        );
        writeAuditLog(db, {
          actorId: req.user!.id,
          actorUsername: req.user!.username,
          action: 'ADMIN_REMOVED_GROUP_MEMBER',
          entityType: 'group',
          entityId: groupId,
          roomId,
          details: { userId },
          req,
        });
      })();

      realtime.broadcast(roomId, 'group:updated', { groupId });
      res.json({ ok: true });
    }
  );

  // Admin approve pending membership
  router.post(
    '/rooms/:roomId/groups/:groupId/members/:userId/approve',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    (req: AuthedRequest, res) => {
      const { roomId, groupId, userId } = req.params;
      db.prepare(
        `UPDATE group_members SET approval_status = 'APPROVED', assigned_by = ? WHERE room_id = ? AND group_id = ? AND user_id = ?`
      ).run(req.user!.id, roomId, groupId, userId);
      realtime.broadcast(roomId, 'group:updated', { groupId });
      res.json({ ok: true });
    }
  );

  // Update scoring rubric & criteria
  router.put(
    '/rooms/:roomId/rubric',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    (req: AuthedRequest, res) => {
      const { roomId } = req.params;
      const title = sanitizeText(req.body?.title || 'Rubric Thuyết trình', 140);
      const scoringMode: ScoringMode = req.body?.scoringMode === 'WEIGHTED' ? 'WEIGHTED' : 'SUM';
      const decimalPrecision: 0 | 1 | 2 =
        req.body?.decimalPrecision === 0 || req.body?.decimalPrecision === 2
          ? req.body.decimalPrecision
          : 1;
      const rawCriteria = Array.isArray(req.body?.criteria) ? req.body.criteria : [];

      if (rawCriteria.length === 0) {
        res.status(400).json({ error: 'Rubric phải có ít nhất 1 tiêu chí chấm điểm.' });
        return;
      }

      const parsedCriteria: RubricCriterionDef[] = [];
      for (let i = 0; i < rawCriteria.length; i++) {
        const c = rawCriteria[i];
        const cName = sanitizeText(c?.name, 120);
        const minScore = Number(c?.minScore ?? 0);
        const maxScore = Number(c?.maxScore ?? 10);
        const weight = Number(c?.weight ?? maxScore);
        if (!cName || !Number.isFinite(minScore) || !Number.isFinite(maxScore) || maxScore <= minScore || minScore < 0 || weight <= 0) {
          res.status(400).json({ error: `Tiêu chí thứ ${i + 1} có giá trị min/max/trọng số không hợp lệ.` });
          return;
        }
        parsedCriteria.push({
          id: typeof c?.id === 'string' && c.id.length > 0 ? c.id : `crit_${crypto.randomUUID().slice(0, 8)}`,
          name: cName,
          minScore,
          maxScore,
          weight,
          sortOrder: i + 1,
        });
      }

      const submittedCount = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM assessments WHERE room_id = ? AND status IN ('SUBMITTED', 'REVIEWED', 'FINALIZED')`
          )
          .get(roomId) as { c: number }
      ).c;

      const rubric = db.prepare('SELECT id FROM scoring_rubrics WHERE room_id = ?').get(roomId) as
        | { id: string }
        | undefined;
      if (!rubric) {
        res.status(404).json({ error: 'Không tìm thấy rubric của phòng.' });
        return;
      }

      if (submittedCount > 0) {
        // Prevent removing existing criteria that already have submitted scores
        const existingCritIds = (
          db.prepare('SELECT id FROM rubric_criteria WHERE rubric_id = ?').all(rubric.id) as Array<{
            id: string;
          }>
        ).map((r) => r.id);
        const nextIds = new Set(parsedCriteria.map((c) => c.id));
        const removed = existingCritIds.some((id) => !nextIds.has(id));
        if (removed) {
          res.status(400).json({
            error: 'Không thể xóa tiêu chí đã có phiếu chấm được nộp. Bạn chỉ có thể sửa mô tả hoặc thêm trước khi bắt đầu chấm.',
          });
          return;
        }
      }

      const maxTotalScore = computeMaxPossibleScore(parsedCriteria, scoringMode, decimalPrecision);
      if (maxTotalScore > 10) {
        res.status(400).json({
          error: `Tổng điểm tối đa hiện là ${maxTotalScore}. Hệ thống chỉ cho phép thang điểm tối đa 10 điểm.`,
        });
        return;
      }

      db.transaction(() => {
        db.prepare(
          `UPDATE scoring_rubrics
           SET title = ?, scoring_mode = ?, decimal_precision = ?, max_total_score = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(title, scoringMode, decimalPrecision, maxTotalScore, rubric.id);

        const existingIds = new Set(
          (
            db.prepare('SELECT id FROM rubric_criteria WHERE rubric_id = ?').all(rubric.id) as Array<{
              id: string;
            }>
          ).map((r) => r.id)
        );
        const incomingIds = new Set(parsedCriteria.map((c) => c.id));
        for (const oldId of existingIds) {
          if (!incomingIds.has(oldId)) {
            db.prepare('DELETE FROM rubric_criteria WHERE id = ?').run(oldId);
          }
        }

        const upsertCrit = db.prepare(
          `INSERT INTO rubric_criteria (id, rubric_id, name, description, min_score, max_score, weight, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             min_score = excluded.min_score,
             max_score = excluded.max_score,
             weight = excluded.weight,
             sort_order = excluded.sort_order`
        );

        rawCriteria.forEach((raw: { description?: unknown }, idx: number) => {
          const c = parsedCriteria[idx];
          upsertCrit.run(
            c.id,
            rubric.id,
            c.name,
            sanitizeText(raw?.description, 300),
            c.minScore,
            c.maxScore,
            c.weight,
            c.sortOrder
          );
        });

        writeAuditLog(db, {
          actorId: req.user!.id,
          actorUsername: req.user!.username,
          action: 'RUBRIC_UPDATED',
          entityType: 'rubric',
          entityId: rubric.id,
          roomId,
          details: { scoringMode, maxTotalScore, criteriaCount: parsedCriteria.length },
          req,
        });
      })();

      realtime.broadcast(roomId, 'room:updated', { rubricUpdated: true });
      res.json({
        rubric: db.prepare('SELECT * FROM scoring_rubrics WHERE id = ?').get(rubric.id),
        criteria: db
          .prepare('SELECT * FROM rubric_criteria WHERE rubric_id = ? ORDER BY sort_order ASC')
          .all(rubric.id),
      });
    }
  );

  // Assign/update grader in room
  router.post('/rooms/:roomId/graders', requireRole('SUPER_ADMIN', 'TEACHER'), (req: AuthedRequest, res) => {
    const { roomId } = req.params;
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    const weight = Math.max(0.1, Math.min(10, Number(req.body?.graderWeight) || 1.0));

    const user = db.prepare(`SELECT id, role FROM users WHERE id = ? AND role IN ('TEACHER', 'GRADER', 'SUPER_ADMIN')`).get(userId) as
      | { id: string; role: string }
      | undefined;
    if (!user) {
      res.status(404).json({ error: 'Không tìm thấy giáo viên hoặc giám khảo hợp lệ.' });
      return;
    }

    db.prepare(
      `INSERT INTO room_members (id, room_id, user_id, room_role, grader_weight)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(room_id, user_id) DO UPDATE SET grader_weight = excluded.grader_weight`
    ).run(crypto.randomUUID(), roomId, userId, user.role === 'GRADER' ? 'GRADER' : 'TEACHER', weight);

    writeAuditLog(db, {
      actorId: req.user!.id,
      actorUsername: req.user!.username,
      action: 'ROOM_GRADER_ASSIGNED',
      entityType: 'room',
      entityId: roomId,
      roomId,
      details: { userId, weight },
      req,
    });

    res.json({ ok: true });
  });

  router.delete(
    '/rooms/:roomId/graders/:userId',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    (req: AuthedRequest, res) => {
      const { roomId, userId } = req.params;
      db.prepare(`DELETE FROM room_members WHERE room_id = ? AND user_id = ? AND room_role = 'GRADER'`).run(
        roomId,
        userId
      );
      res.json({ ok: true });
    }
  );

  return router;
}
