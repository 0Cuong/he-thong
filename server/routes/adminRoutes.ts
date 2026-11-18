import crypto from 'node:crypto';
import { Router } from 'express';
import ExcelJS from 'exceljs';
import type { DB } from '../db.ts';
import {
  hashPassword,
  rateLimitMiddleware,
  sanitizeText,
  sanitizeUsername,
  SlidingWindowRateLimiter,
} from '../security.ts';
import { requireRole, writeAuditLog, type AuthedRequest } from '../middleware.ts';
import type { UserRole } from '../../src/lib/domain.ts';

export function createAdminRouter(db: DB) {
  const router = Router();
  const resetLimiter = new SlidingWindowRateLimiter(5 * 60 * 1000, 30);

  // Admin overview metrics
  router.get('/admin/overview', requireRole('SUPER_ADMIN', 'TEACHER'), (req: AuthedRequest, res) => {
    const classroomCount = (
      db.prepare(`SELECT COUNT(*) as c FROM classrooms WHERE status = 'ACTIVE'`).get() as { c: number }
    ).c;
    const studentCount = (
      db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'STUDENT' AND is_active = 1`).get() as {
        c: number;
      }
    ).c;
    const totalStudents = (
      db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'STUDENT'`).get() as { c: number }
    ).c;
    const graderCount = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM users WHERE role IN ('TEACHER', 'GRADER') AND is_active = 1`
        )
        .get() as { c: number }
    ).c;
    const activeRooms = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM rooms WHERE status IN ('REGISTRATION_OPEN', 'READY', 'IN_PROGRESS', 'PAUSED')`
        )
        .get() as { c: number }
    ).c;
    const totalGroups = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM groups g JOIN rooms r ON r.id = g.room_id WHERE r.status <> 'ARCHIVED'`
        )
        .get() as { c: number }
    ).c;
    const completedAssessments = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM assessments WHERE status IN ('SUBMITTED', 'REVIEWED', 'FINALIZED')`
        )
        .get() as { c: number }
    ).c;
    const draftAssessments = (
      db
        .prepare(`SELECT COUNT(*) as c FROM assessments WHERE status IN ('DRAFT', 'IN_PROGRESS')`)
        .get() as { c: number }
    ).c;

    const recentAudits = db
      .prepare(
        `SELECT id, actor_username, action, entity_type, entity_id, room_id, details_json, created_at
         FROM audit_logs
         ORDER BY created_at DESC, rowid DESC
         LIMIT 15`
      )
      .all();

    res.json({
      stats: {
        classroomCount,
        studentCount,
        totalStudents,
        graderCount,
        activeRooms,
        totalGroups,
        completedAssessments,
        pendingAssessments: draftAssessments,
      },
      recentAudits,
    });
  });

  // Classrooms CRUD
  router.get('/classrooms', requireRole('SUPER_ADMIN', 'TEACHER', 'GRADER'), (req: AuthedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM classroom_members cm WHERE cm.classroom_id = c.id AND cm.member_role = 'STUDENT') as student_count,
                (SELECT COUNT(*) FROM rooms r WHERE r.classroom_id = c.id) as room_count
         FROM classrooms c
         ORDER BY c.created_at DESC`
      )
      .all();
    res.json({ classrooms: rows });
  });

  router.post('/classrooms', requireRole('SUPER_ADMIN', 'TEACHER'), (req: AuthedRequest, res) => {
    const name = sanitizeText(req.body?.name, 120);
    const code = sanitizeUsername(req.body?.code).toUpperCase();
    const academicYear = sanitizeText(req.body?.academicYear || '2026-2027', 30);
    const description = sanitizeText(req.body?.description, 500);

    if (!name || !code) {
      res.status(400).json({ error: 'Vui lòng nhập tên lớp và mã lớp.' });
      return;
    }

    const exists = db.prepare('SELECT id FROM classrooms WHERE code = ?').get(code);
    if (exists) {
      res.status(409).json({ error: `Mã lớp "${code}" đã tồn tại.` });
      return;
    }

    const id = `cls_${crypto.randomUUID().slice(0, 8)}`;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO classrooms (id, name, code, academic_year, description, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`
      ).run(id, name, code, academicYear, description, req.user!.id);

      db.prepare(
        `INSERT INTO classroom_members (id, classroom_id, user_id, member_role)
         VALUES (?, ?, ?, ?)`
      ).run(crypto.randomUUID(), id, req.user!.id, req.user!.role === 'GRADER' ? 'GRADER' : 'TEACHER');

      writeAuditLog(db, {
        actorId: req.user!.id,
        actorUsername: req.user!.username,
        action: 'CLASSROOM_CREATED',
        entityType: 'classroom',
        entityId: id,
        details: { name, code },
        req,
      });
    })();

    const created = db.prepare('SELECT * FROM classrooms WHERE id = ?').get(id);
    res.status(201).json({ classroom: created });
  });

  router.patch('/classrooms/:id', requireRole('SUPER_ADMIN', 'TEACHER'), (req: AuthedRequest, res) => {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM classrooms WHERE id = ?').get(id) as
      | { id: string; name: string; academic_year: string; description: string; status: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Không tìm thấy lớp học.' });
      return;
    }

    const name = req.body?.name !== undefined ? sanitizeText(req.body.name, 120) : existing.name;
    const academicYear =
      req.body?.academicYear !== undefined
        ? sanitizeText(req.body.academicYear, 30)
        : existing.academic_year;
    const description =
      req.body?.description !== undefined
        ? sanitizeText(req.body.description, 500)
        : existing.description;
    const status =
      req.body?.status === 'ACTIVE' || req.body?.status === 'ARCHIVED'
        ? req.body.status
        : existing.status;

    if (!name) {
      res.status(400).json({ error: 'Tên lớp không được để trống.' });
      return;
    }

    db.prepare(
      `UPDATE classrooms SET name = ?, academic_year = ?, description = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(name, academicYear, description, status, id);

    writeAuditLog(db, {
      actorId: req.user!.id,
      actorUsername: req.user!.username,
      action: 'CLASSROOM_UPDATED',
      entityType: 'classroom',
      entityId: id,
      details: { name, status },
      req,
    });

    res.json({ classroom: db.prepare('SELECT * FROM classrooms WHERE id = ?').get(id) });
  });

  router.delete('/classrooms/:id', requireRole('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const { id } = req.params;
    const roomCount = (
      db.prepare('SELECT COUNT(*) as c FROM rooms WHERE classroom_id = ?').get(id) as { c: number }
    ).c;
    if (roomCount > 0) {
      res.status(400).json({
        error: 'Không thể xóa lớp đang có phòng thuyết trình. Hãy lưu trữ lớp học thay vì xóa.',
      });
      return;
    }
    const info = db.prepare('DELETE FROM classrooms WHERE id = ?').run(id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Không tìm thấy lớp học.' });
      return;
    }
    writeAuditLog(db, {
      actorId: req.user!.id,
      actorUsername: req.user!.username,
      action: 'CLASSROOM_DELETED',
      entityType: 'classroom',
      entityId: id,
      req,
    });
    res.json({ ok: true });
  });

  // Users list with search, role filter, status filter, pagination (never exposes password_hash)
  router.get('/users', requireRole('SUPER_ADMIN', 'TEACHER'), (req: AuthedRequest, res) => {
    const search = sanitizeText(req.query.search, 100).toLowerCase();
    const role = typeof req.query.role === 'string' ? req.query.role : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const classroomId = typeof req.query.classroomId === 'string' ? req.query.classroomId : '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];

    if (role && ['SUPER_ADMIN', 'TEACHER', 'GRADER', 'STUDENT'].includes(role)) {
      conditions.push('u.role = ?');
      params.push(role);
    }
    if (status === 'active') {
      conditions.push('u.is_active = 1');
    } else if (status === 'disabled') {
      conditions.push('u.is_active = 0');
    }
    if (classroomId) {
      conditions.push(
        'EXISTS (SELECT 1 FROM classroom_members cm WHERE cm.user_id = u.id AND cm.classroom_id = ?)'
      );
      params.push(classroomId);
    }
    if (search) {
      conditions.push(
        '(LOWER(u.username) LIKE ? OR LOWER(COALESCE(p.full_name, \'\')) LIKE ? OR LOWER(COALESCE(p.student_code, \'\')) LIKE ? OR LOWER(COALESCE(p.email, \'\')) LIKE ?)'
      );
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }

    const where = conditions.join(' AND ');
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE ${where}`
        )
        .get(...params) as { c: number }
    ).c;

    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.is_active, u.must_change_password, u.last_login_at, u.login_count, u.created_at,
                p.full_name, p.student_code, p.email, p.phone
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE ${where}
         ORDER BY u.role ASC, u.username ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    res.json({ users: rows, total, page, limit });
  });

  // Create single account
  router.post('/users', requireRole('SUPER_ADMIN', 'TEACHER'), (req: AuthedRequest, res) => {
    const username = sanitizeUsername(req.body?.username);
    const fullName = sanitizeText(req.body?.fullName, 120);
    const studentCode = sanitizeUsername(req.body?.studentCode || username).toUpperCase();
    const email = sanitizeText(req.body?.email, 120);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const requestedRole = (req.body?.role as UserRole) || 'STUDENT';
    const classroomId = typeof req.body?.classroomId === 'string' ? req.body.classroomId : '';
    const mustChangePassword = req.body?.mustChangePassword !== false;

    if (!username || !fullName || password.length < 6) {
      res.status(400).json({ error: 'Cần nhập tên đăng nhập, họ tên và mật khẩu tối thiểu 6 ký tự.' });
      return;
    }

    if (!['SUPER_ADMIN', 'TEACHER', 'GRADER', 'STUDENT'].includes(requestedRole)) {
      res.status(400).json({ error: 'Vai trò không hợp lệ.' });
      return;
    }

    // Only Super Admin can create Teacher or Super Admin accounts
    if (
      (requestedRole === 'SUPER_ADMIN' || requestedRole === 'TEACHER') &&
      req.user!.role !== 'SUPER_ADMIN'
    ) {
      res.status(403).json({ error: 'Chỉ Quản trị hệ thống mới được tạo tài khoản Giáo viên hoặc Quản trị viên.' });
      return;
    }

    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) {
      res.status(409).json({ error: `Tên đăng nhập "${username}" đã tồn tại.` });
      return;
    }

    const userId = `usr_${crypto.randomUUID().slice(0, 10)}`;
    const passHash = hashPassword(password);

    db.transaction(() => {
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, is_active, must_change_password)
         VALUES (?, ?, ?, ?, 1, ?)`
      ).run(userId, username, passHash, requestedRole, mustChangePassword ? 1 : 0);

      db.prepare(
        `INSERT INTO profiles (user_id, full_name, student_code, email)
         VALUES (?, ?, ?, ?)`
      ).run(userId, fullName, studentCode || null, email || null);

      if (classroomId) {
        const clsExists = db.prepare('SELECT id FROM classrooms WHERE id = ?').get(classroomId);
        if (clsExists) {
          db.prepare(
            `INSERT OR IGNORE INTO classroom_members (id, classroom_id, user_id, member_role)
             VALUES (?, ?, ?, ?)`
          ).run(
            crypto.randomUUID(),
            classroomId,
            userId,
            requestedRole === 'STUDENT' ? 'STUDENT' : requestedRole === 'GRADER' ? 'GRADER' : 'TEACHER'
          );
        }
      }

      writeAuditLog(db, {
        actorId: req.user!.id,
        actorUsername: req.user!.username,
        action: 'USER_CREATED',
        entityType: 'user',
        entityId: userId,
        details: { username, role: requestedRole },
        req,
      });
    })();

    const created = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.is_active, u.must_change_password, u.last_login_at, u.login_count,
                p.full_name, p.student_code, p.email
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`
      )
      .get(userId);
    res.status(201).json({ user: created });
  });

  // Bulk auto-generate student accounts (e.g. HS001..HS048)
  router.post(
    '/users/bulk-generate-students',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    (req: AuthedRequest, res) => {
      const prefix = sanitizeUsername(req.body?.prefix || 'HS').toUpperCase() || 'HS';
      const count = Math.min(200, Math.max(1, Number(req.body?.count) || 48));
      const startNumber = Math.max(1, Number(req.body?.startNumber) || 1);
      const padDigits = Math.min(5, Math.max(2, Number(req.body?.padDigits) || 3));
      const defaultPassword =
        typeof req.body?.defaultPassword === 'string' && req.body.defaultPassword.length >= 6
          ? req.body.defaultPassword
          : 'Student@123';
      const classroomId = typeof req.body?.classroomId === 'string' ? req.body.classroomId : '';
      const mustChangePassword = req.body?.mustChangePassword !== false;

      const passHash = hashPassword(defaultPassword);
      let createdCount = 0;
      let skippedCount = 0;
      const createdUsernames: string[] = [];

      db.transaction(() => {
        const findUser = db.prepare('SELECT id FROM users WHERE username = ?');
        const insertUser = db.prepare(
          `INSERT INTO users (id, username, password_hash, role, is_active, must_change_password)
           VALUES (?, ?, ?, 'STUDENT', 1, ?)`
        );
        const insertProfile = db.prepare(
          `INSERT INTO profiles (user_id, full_name, student_code, email)
           VALUES (?, ?, ?, ?)`
        );
        const enrollClass = db.prepare(
          `INSERT OR IGNORE INTO classroom_members (id, classroom_id, user_id, member_role)
           VALUES (?, ?, ?, 'STUDENT')`
        );

        for (let i = 0; i < count; i++) {
          const numStr = String(startNumber + i).padStart(padDigits, '0');
          const username = `${prefix}${numStr}`;
          const existing = findUser.get(username) as { id: string } | undefined;
          if (existing) {
            skippedCount++;
            if (classroomId) {
              enrollClass.run(crypto.randomUUID(), classroomId, existing.id);
            }
            continue;
          }

          const uid = `usr_${crypto.randomUUID().slice(0, 10)}`;
          insertUser.run(uid, username, passHash, mustChangePassword ? 1 : 0);
          insertProfile.run(
            uid,
            `Học sinh ${username}`,
            username,
            `${username.toLowerCase()}@student.12a17.edu.vn`
          );
          if (classroomId) {
            enrollClass.run(crypto.randomUUID(), classroomId, uid);
          }
          createdCount++;
          createdUsernames.push(username);
        }

        writeAuditLog(db, {
          actorId: req.user!.id,
          actorUsername: req.user!.username,
          action: 'USERS_BULK_GENERATED',
          entityType: 'user',
          entityId: prefix,
          details: { prefix, count, createdCount, skippedCount, classroomId },
          req,
        });
      })();

      res.status(201).json({
        createdCount,
        skippedCount,
        sampleCreated: createdUsernames.slice(0, 10),
      });
    }
  );

  // Import students from CSV or XLSX (base64 payload)
  router.post(
    '/users/import-students',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    async (req: AuthedRequest, res) => {
      try {
        const filename = sanitizeText(req.body?.filename, 120).toLowerCase();
        const base64 = typeof req.body?.base64 === 'string' ? req.body.base64 : '';
        const classroomId = typeof req.body?.classroomId === 'string' ? req.body.classroomId : '';
        const defaultPassword =
          typeof req.body?.defaultPassword === 'string' && req.body.defaultPassword.length >= 6
            ? req.body.defaultPassword
            : 'Student@123';

        if (!base64) {
          res.status(400).json({ error: 'Không có nội dung tệp tải lên.' });
          return;
        }

        const buffer = Buffer.from(base64, 'base64');
        const rows: Array<{ username: string; fullName: string; studentCode: string; email: string }> = [];

        if (filename.endsWith('.xlsx')) {
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(buffer as unknown as ArrayBuffer);
          const ws = wb.worksheets[0];
          if (!ws) {
            res.status(400).json({ error: 'Tệp Excel không có trang tính hợp lệ.' });
            return;
          }
          ws.eachRow((row, rowNum) => {
            const c1 = sanitizeUsername(String(row.getCell(1).value ?? ''));
            const c2 = sanitizeText(String(row.getCell(2).value ?? ''), 120);
            const c3 = sanitizeText(String(row.getCell(3).value ?? ''), 120);
            if (rowNum === 1 && /username|tên đăng nhập|mã/i.test(c1 + ' ' + c2)) return;
            if (c1 && c2) {
              rows.push({ username: c1, fullName: c2, studentCode: c1.toUpperCase(), email: c3 });
            }
          });
        } else {
          // Parse UTF-8 CSV
          const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
          const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
          lines.forEach((line, idx) => {
            const parts = line.split(',').map((p) => p.replace(/^"|"$/g, '').trim());
            const u = sanitizeUsername(parts[0] ?? '');
            const fn = sanitizeText(parts[1] ?? '', 120);
            const em = sanitizeText(parts[2] ?? '', 120);
            if (idx === 0 && /username|tên đăng nhập|mã/i.test((parts[0] ?? '') + ' ' + fn)) return;
            if (u && fn) {
              rows.push({ username: u, fullName: fn, studentCode: u.toUpperCase(), email: em });
            }
          });
        }

        if (rows.length === 0) {
          res.status(400).json({
            error: 'Không đọc được dòng dữ liệu hợp lệ nào (cần cột 1: Tên đăng nhập/Mã HS, cột 2: Họ tên).',
          });
          return;
        }

        const passHash = hashPassword(defaultPassword);
        let imported = 0;
        let updated = 0;

        db.transaction(() => {
          const findUser = db.prepare('SELECT id FROM users WHERE username = ?');
          const insertUser = db.prepare(
            `INSERT INTO users (id, username, password_hash, role, is_active, must_change_password)
             VALUES (?, ?, ?, 'STUDENT', 1, 1)`
          );
          const insertProfile = db.prepare(
            `INSERT INTO profiles (user_id, full_name, student_code, email) VALUES (?, ?, ?, ?)`
          );
          const updateProfile = db.prepare(
            `UPDATE profiles SET full_name = ?, email = COALESCE(NULLIF(?, ''), email), updated_at = datetime('now') WHERE user_id = ?`
          );
          const enroll = db.prepare(
            `INSERT OR IGNORE INTO classroom_members (id, classroom_id, user_id, member_role) VALUES (?, ?, ?, 'STUDENT')`
          );

          for (const r of rows) {
            const existing = findUser.get(r.username) as { id: string } | undefined;
            if (existing) {
              updateProfile.run(r.fullName, r.email, existing.id);
              if (classroomId) enroll.run(crypto.randomUUID(), classroomId, existing.id);
              updated++;
            } else {
              const uid = `usr_${crypto.randomUUID().slice(0, 10)}`;
              insertUser.run(uid, r.username, passHash);
              insertProfile.run(uid, r.fullName, r.studentCode, r.email || null);
              if (classroomId) enroll.run(crypto.randomUUID(), classroomId, uid);
              imported++;
            }
          }

          writeAuditLog(db, {
            actorId: req.user!.id,
            actorUsername: req.user!.username,
            action: 'STUDENTS_IMPORTED',
            entityType: 'user',
            entityId: classroomId || 'global',
            details: { filename, imported, updated },
            req,
          });
        })();

        res.json({ imported, updated, totalProcessed: rows.length });
      } catch (err) {
        console.error('Import students error:', err);
        res.status(400).json({ error: 'Định dạng tệp CSV/Excel không hợp lệ.' });
      }
    }
  );

  // Safe student CSV export (NEVER includes passwords or hashes)
  router.get('/users/export-students', requireRole('SUPER_ADMIN', 'TEACHER'), (_req, res) => {
    const rows = db
      .prepare(
        `SELECT u.username, p.student_code, p.full_name, p.email, u.is_active, u.last_login_at, u.login_count
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE u.role = 'STUDENT'
         ORDER BY u.username ASC`
      )
      .all() as Array<{
      username: string;
      student_code: string | null;
      full_name: string | null;
      email: string | null;
      is_active: number;
      last_login_at: string | null;
      login_count: number;
    }>;

    const escape = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csv =
      '\uFEFF' +
      [
        ['Tên đăng nhập', 'Mã HS', 'Họ và tên', 'Email', 'Trạng thái', 'Đăng nhập gần nhất', 'Số lần đăng nhập']
          .map(escape)
          .join(','),
        ...rows.map((r) =>
          [
            r.username,
            r.student_code ?? '',
            r.full_name ?? '',
            r.email ?? '',
            r.is_active === 1 ? 'Đang hoạt động' : 'Đã khóa',
            r.last_login_at ?? 'Chưa đăng nhập',
            r.login_count,
          ]
            .map(escape)
            .join(',')
        ),
      ].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="danh-sach-hoc-sinh.csv"');
    res.send(csv);
  });

  // Update user profile, username, or active status
  router.patch('/users/:id', requireRole('SUPER_ADMIN', 'TEACHER'), (req: AuthedRequest, res) => {
    const { id } = req.params;
    const target = db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(id) as
      | { id: string; username: string; role: UserRole; is_active: number }
      | undefined;
    if (!target) {
      res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
      return;
    }

    if (
      (target.role === 'SUPER_ADMIN' || target.role === 'TEACHER') &&
      req.user!.role !== 'SUPER_ADMIN' &&
      target.id !== req.user!.id
    ) {
      res.status(403).json({ error: 'Không đủ quyền chỉnh sửa tài khoản quản trị/giáo viên khác.' });
      return;
    }

    const newUsername =
      req.body?.username !== undefined ? sanitizeUsername(req.body.username) : target.username;
    const fullName = req.body?.fullName !== undefined ? sanitizeText(req.body.fullName, 120) : undefined;
    const email = req.body?.email !== undefined ? sanitizeText(req.body.email, 120) : undefined;
    const isActive =
      typeof req.body?.isActive === 'boolean' ? (req.body.isActive ? 1 : 0) : target.is_active;

    if (!newUsername) {
      res.status(400).json({ error: 'Tên đăng nhập không hợp lệ.' });
      return;
    }
    if (target.id === req.user!.id && isActive === 0) {
      res.status(400).json({ error: 'Không thể tự vô hiệu hóa chính tài khoản đang đăng nhập.' });
      return;
    }

    try {
      db.transaction(() => {
        db.prepare(`UPDATE users SET username = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`).run(
          newUsername,
          isActive,
          id
        );

        if (fullName !== undefined || email !== undefined) {
          db.prepare(
            `UPDATE profiles
             SET full_name = COALESCE(?, full_name),
                 email = COALESCE(?, email),
                 updated_at = datetime('now')
             WHERE user_id = ?`
          ).run(fullName ?? null, email ?? null, id);
        }

        if (isActive === 0) {
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        }

        writeAuditLog(db, {
          actorId: req.user!.id,
          actorUsername: req.user!.username,
          action: isActive === 0 ? 'USER_DISABLED' : 'USER_UPDATED',
          entityType: 'user',
          entityId: id,
          details: { username: newUsername, isActive },
          req,
        });
      })();
    } catch {
      res.status(409).json({ error: `Tên đăng nhập "${newUsername}" đã được sử dụng.` });
      return;
    }

    const updated = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.is_active, u.must_change_password, u.last_login_at, u.login_count,
                p.full_name, p.student_code, p.email
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`
      )
      .get(id);
    res.json({ user: updated });
  });

  // Admin password reset (never exposes existing password)
  router.post(
    '/users/:id/reset-password',
    requireRole('SUPER_ADMIN', 'TEACHER'),
    rateLimitMiddleware(resetLimiter, (req: AuthedRequest) => req.user!.id),
    (req: AuthedRequest, res) => {
      const { id } = req.params;
      const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
      const mustChangePassword = req.body?.mustChangePassword !== false;

      if (newPassword.length < 6) {
        res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự.' });
        return;
      }

      const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as
        | { id: string; username: string; role: UserRole }
        | undefined;
      if (!target) {
        res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
        return;
      }

      if (
        (target.role === 'SUPER_ADMIN' || target.role === 'TEACHER') &&
        req.user!.role !== 'SUPER_ADMIN' &&
        target.id !== req.user!.id
      ) {
        res.status(403).json({ error: 'Chỉ Quản trị hệ thống mới được đặt lại mật khẩu giáo viên/quản trị.' });
        return;
      }

      const hash = hashPassword(newPassword);
      db.transaction(() => {
        db.prepare(
          `UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(hash, mustChangePassword ? 1 : 0, id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        writeAuditLog(db, {
          actorId: req.user!.id,
          actorUsername: req.user!.username,
          action: 'USER_PASSWORD_RESET',
          entityType: 'user',
          entityId: id,
          details: { targetUsername: target.username },
          req,
        });
      })();

      res.json({ ok: true });
    }
  );

  // Audit Logs
  router.get('/audit-logs', requireRole('SUPER_ADMIN', 'TEACHER'), (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : '';
    const action = sanitizeText(req.query.action, 60);

    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];
    if (roomId) {
      conditions.push('room_id = ?');
      params.push(roomId);
    }
    if (action) {
      conditions.push('action LIKE ?');
      params.push(`%${action}%`);
    }

    const logs = db
      .prepare(
        `SELECT id, actor_id, actor_username, action, entity_type, entity_id, room_id, details_json, ip_address, created_at
         FROM audit_logs
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(...params, limit);

    res.json({ logs });
  });

  // System settings (Super Admin / Teacher read, Super Admin write)
  router.get('/settings', requireRole('SUPER_ADMIN', 'TEACHER'), (_req, res) => {
    const rows = db.prepare('SELECT key, value, updated_at FROM system_settings').all() as Array<{
      key: string;
      value: string;
      updated_at: string;
    }>;
    const settings: Record<string, string> = {
      default_student_count: '48',
      default_group_count: '8',
      default_group_capacity: '6',
      institution_name: 'Trường THPT — Lớp 12A17',
    };
    for (const r of rows) {
      settings[r.key] = r.value;
    }
    res.json({ settings });
  });

  router.patch('/settings', requireRole('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const updates = req.body?.settings;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({ error: 'Dữ liệu cấu hình không hợp lệ.' });
      return;
    }
    const upsert = db.prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    );
    db.transaction(() => {
      for (const [k, v] of Object.entries(updates)) {
        const cleanKey = sanitizeUsername(k);
        if (!cleanKey) continue;
        upsert.run(cleanKey, sanitizeText(String(v ?? ''), 300));
      }
      writeAuditLog(db, {
        actorId: req.user!.id,
        actorUsername: req.user!.username,
        action: 'SYSTEM_SETTINGS_UPDATED',
        entityType: 'system_settings',
        entityId: 'global',
        req,
      });
    })();
    res.json({ ok: true });
  });

  return router;
}
