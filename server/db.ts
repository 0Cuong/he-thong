import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { hashPassword } from './security.ts';

export type DB = Database.Database;

const VIETNAMESE_STUDENT_NAMES = [
  'Nguyễn Minh Anh', 'Trần Bảo Châu', 'Lê Hoàng Dũng', 'Phạm Gia Hân',
  'Huỳnh Quốc Bảo', 'Võ Ngọc Diệp', 'Đặng Tuấn Kiệt', 'Bùi Khánh Linh',
  'Đỗ Quang Minh', 'Hồ Thảo Nhi', 'Ngô Đức Phát', 'Dương Phương Quyên',
  'Lý Thanh Sơn', 'Phan Thảo Vy', 'Vũ Hải Đăng', 'Trịnh Ngọc Ánh',
  'Mai Xuân Bách', 'Đinh Hải Yến', 'Lâm Gia Bảo', 'Tô Khánh Huyền',
  'Chu Minh Khôi', 'Tạ Bảo Ngọc', 'Lưu Nhật Nam', 'Cao Thanh Trúc',
  'Trương Tiến Đạt', 'Nguyễn Ngọc Hân', 'Trần Anh Khoa', 'Lê Thị Thu Hà',
  'Phạm Nhật Minh', 'Võ Hoàng Phúc', 'Đặng Mỹ Duyên', 'Bùi Trung Hiếu',
  'Đỗ Lan Anh', 'Hồ Gia Huy', 'Ngô Bảo Trâm', 'Dương Văn Long',
  'Lý Kim Ngân', 'Phan Đình Trọng', 'Vũ Thị Mai Phương', 'Trịnh Công Danh',
  'Mai Bảo Vy', 'Đinh Trọng Nghĩa', 'Lâm Quỳnh Như', 'Tô Minh Quân',
  'Chu Thảo Nguyên', 'Tạ Hoàng Việt', 'Lưu Ngọc Bích', 'Cao Thiên Ân',
];

export function openDatabase(dbPath?: string): DB {
  const targetPath = dbPath ?? process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'classroom48.db');
  if (targetPath !== ':memory:') {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }

  const db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  seedInitialData(db);
  return db;
}

export function runMigrations(db: DB): void {
  const migrationsDir = path.resolve(process.cwd(), 'server', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(file);
  }
}

export function seedInitialData(db: DB): void {
  const existingUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (existingUsers.cnt > 0) return;

  const tx = db.transaction(() => {
    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, is_active, must_change_password)
      VALUES (?, ?, ?, ?, 1, 0)
    `);
    const insertProfile = db.prepare(`
      INSERT INTO profiles (user_id, full_name, student_code, email)
      VALUES (?, ?, ?, ?)
    `);

    const superAdminId = 'usr_super_admin';
    const teacherId = 'usr_teacher_01';
    const grader1Id = 'usr_grader_01';
    const grader2Id = 'usr_grader_02';

    insertUser.run(superAdminId, 'admin', hashPassword('Admin@1234'), 'SUPER_ADMIN');
    insertProfile.run(superAdminId, 'Quản trị viên Hệ thống', 'ADM001', 'admin@12a17.edu.vn');

    insertUser.run(teacherId, 'teacher01', hashPassword('Teacher@1234'), 'TEACHER');
    insertProfile.run(teacherId, 'Cô Nguyễn Thu Trang', 'GV001', 'trang.nguyen@12a17.edu.vn');

    insertUser.run(grader1Id, 'grader01', hashPassword('Grader@1234'), 'GRADER');
    insertProfile.run(grader1Id, 'Thầy Trần Hữu Nghĩa', 'GK001', 'nghia.tran@12a17.edu.vn');

    insertUser.run(grader2Id, 'grader02', hashPassword('Grader@1234'), 'GRADER');
    insertProfile.run(grader2Id, 'Cô Lê Minh Tâm', 'GK002', 'tam.le@12a17.edu.vn');

    const classroomId = 'cls_12a17';
    db.prepare(`
      INSERT INTO classrooms (id, name, code, academic_year, description, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)
    `).run(
      classroomId,
      'Lớp 12A17',
      '12A17',
      '2026-2027',
      'Lớp 12A17 gồm 48 học sinh chia 8 nhóm thuyết trình (thang điểm tối đa 10).',
      teacherId
    );

    const insertClassMember = db.prepare(`
      INSERT INTO classroom_members (id, classroom_id, user_id, member_role)
      VALUES (?, ?, ?, ?)
    `);
    insertClassMember.run(crypto.randomUUID(), classroomId, teacherId, 'TEACHER');
    insertClassMember.run(crypto.randomUUID(), classroomId, grader1Id, 'GRADER');
    insertClassMember.run(crypto.randomUUID(), classroomId, grader2Id, 'GRADER');

    // Create 48 student accounts HS001 .. HS048
    const studentHash = hashPassword('Student@123');
    const studentIds: string[] = [];
    for (let i = 1; i <= 48; i++) {
      const code = `HS${String(i).padStart(3, '0')}`;
      const uid = `usr_${code.toLowerCase()}`;
      studentIds.push(uid);
      insertUser.run(uid, code, studentHash, 'STUDENT');
      insertProfile.run(
        uid,
        VIETNAMESE_STUDENT_NAMES[i - 1] ?? `Học sinh ${code}`,
        code,
        `${code.toLowerCase()}@student.12a17.edu.vn`
      );
      insertClassMember.run(crypto.randomUUID(), classroomId, uid, 'STUDENT');
    }

    // Create default presentation room
    const roomId = 'room_gk_01';
    db.prepare(`
      INSERT INTO rooms (
        id, classroom_id, name, room_code, description, session_date,
        status, allow_student_selection, require_admin_approval,
        lock_groups_on_start, multi_grader_policy, publish_results, publish_feedback, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, 'REGISTRATION_OPEN', 1, 0, 1, 'AVERAGE', 0, 1, ?)
    `).run(
      roomId,
      classroomId,
      'Buổi thuyết trình Lớp 12A17',
      '12A17-GK01',
      'Phòng thuyết trình Lớp 12A17 gồm 8 nhóm (tối đa 6 học sinh/nhóm), thang điểm tối đa 10.',
      '2026-11-20',
      teacherId
    );

    const insertRoomMember = db.prepare(`
      INSERT INTO room_members (id, room_id, user_id, room_role, grader_weight)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertRoomMember.run(crypto.randomUUID(), roomId, teacherId, 'TEACHER', 1.0);
    insertRoomMember.run(crypto.randomUUID(), roomId, grader1Id, 'GRADER', 1.0);
    insertRoomMember.run(crypto.randomUUID(), roomId, grader2Id, 'GRADER', 1.0);
    for (const sid of studentIds) {
      insertRoomMember.run(crypto.randomUUID(), roomId, sid, 'STUDENT', 1.0);
    }

    // Create 8 groups, assign HS001..HS047 (leaving 1 open slot in Nhóm 8 for HS048 to join live!)
    const insertGroup = db.prepare(`
      INSERT INTO groups (id, room_id, name, description, max_capacity, presentation_order, leader_user_id)
      VALUES (?, ?, ?, ?, 6, ?, ?)
    `);
    const insertGroupMember = db.prepare(`
      INSERT INTO group_members (id, room_id, group_id, user_id, approval_status, assigned_by)
      VALUES (?, ?, ?, ?, 'APPROVED', ?)
    `);

    const groupTopics = [
      'Chủ đề 1: Khởi nghiệp & Đổi mới Sáng tạo',
      'Chủ đề 2: Ứng dụng AI trong Học tập',
      'Chủ đề 3: Năng lượng Xanh & Môi trường',
      'Chủ đề 4: An toàn Thông tin Mạng xã hội',
      'Chủ đề 5: Văn hóa Đọc Thời đại Số',
      'Chủ đề 6: Kỹ năng Quản lý Thời gian',
      'Chủ đề 7: Du lịch Bền vững Địa phương',
      'Chủ đề 8: Giao tiếp Hiệu quả trong Nhóm',
    ];

    for (let g = 0; g < 8; g++) {
      const groupId = `grp_gk01_${g + 1}`;
      const startIdx = g * 6;
      const endIdx = g < 7 ? startIdx + 6 : startIdx + 5; // 47 assigned, HS048 open to join Group 8
      const leaderId = studentIds[startIdx] ?? null;

      insertGroup.run(
        groupId,
        roomId,
        `Nhóm ${g + 1}`,
        groupTopics[g],
        g + 1,
        leaderId
      );

      for (let idx = startIdx; idx < endIdx; idx++) {
        insertGroupMember.run(crypto.randomUUID(), roomId, groupId, studentIds[idx], teacherId);
      }
    }

    // Create default 10-point rubric (tổng tối đa 10 điểm)
    const rubricId = 'rub_gk01';
    db.prepare(`
      INSERT INTO scoring_rubrics (id, room_id, title, scoring_mode, decimal_precision, max_total_score)
      VALUES (?, ?, 'Rubric Thuyết trình Thang điểm 10', 'SUM', 2, 10)
    `).run(rubricId, roomId);

    const defaultCriteria = [
      ['Nội dung và kiến thức', 'Độ chính xác chuyên môn, chiều sâu phân tích và dẫn chứng thực tế.', 0, 2, 2, 1],
      ['Cấu trúc bài thuyết trình', 'Bố cục mạch lạc, phân bổ thời gian hợp lý, chuyển ý rõ ràng.', 0, 2, 2, 2],
      ['Kỹ năng trình bày', 'Tác phong tự tin, giọng nói rõ ràng, tương tác với lớp.', 0, 2, 2, 3],
      ['Thiết kế slide', 'Slide thẩm mỹ, trực quan, chữ rõ ràng dễ theo dõi.', 0, 1.5, 1.5, 4],
      ['Làm việc nhóm', 'Phân công đồng đều, hỗ trợ nhau khi trình bày.', 0, 1.5, 1.5, 5],
      ['Trả lời câu hỏi', 'Phản ứng nhanh nhạy, lập luận thuyết phục trước câu hỏi.', 0, 1, 1, 6],
    ] as const;

    const insertCriterion = db.prepare(`
      INSERT INTO rubric_criteria (id, rubric_id, name, description, min_score, max_score, weight, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [name, desc, minS, maxS, weight, order] of defaultCriteria) {
      insertCriterion.run(`crit_gk01_${order}`, rubricId, name, desc, minS, maxS, weight, order);
    }

    db.prepare(`
      INSERT INTO audit_logs (id, actor_id, actor_username, action, entity_type, entity_id, room_id, details_json)
      VALUES (?, ?, 'system', 'SYSTEM_SEED', 'classroom', ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      superAdminId,
      classroomId,
      roomId,
      JSON.stringify({ studentsProvisioned: 48, groupsCreated: 8 })
    );
  });

  tx();
}
