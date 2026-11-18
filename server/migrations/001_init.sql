PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'TEACHER', 'GRADER', 'STUDENT')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  last_login_at TEXT,
  login_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  student_code TEXT,
  email TEXT,
  phone TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS classrooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  academic_year TEXT NOT NULL DEFAULT '2026-2027',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classroom_members (
  id TEXT PRIMARY KEY,
  classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL CHECK (member_role IN ('TEACHER', 'GRADER', 'STUDENT')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (classroom_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_classroom_members_user ON classroom_members(user_id);
CREATE INDEX IF NOT EXISTS idx_classroom_members_classroom ON classroom_members(classroom_id);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  room_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  session_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN (
      'DRAFT',
      'REGISTRATION_OPEN',
      'REGISTRATION_CLOSED',
      'READY',
      'IN_PROGRESS',
      'PAUSED',
      'FINALIZED',
      'ARCHIVED'
    )
  ),
  allow_student_selection INTEGER NOT NULL DEFAULT 1 CHECK (allow_student_selection IN (0, 1)),
  require_admin_approval INTEGER NOT NULL DEFAULT 0 CHECK (require_admin_approval IN (0, 1)),
  lock_groups_on_start INTEGER NOT NULL DEFAULT 1 CHECK (lock_groups_on_start IN (0, 1)),
  multi_grader_policy TEXT NOT NULL DEFAULT 'AVERAGE' CHECK (multi_grader_policy IN ('AVERAGE', 'WEIGHTED_AVERAGE')),
  publish_results INTEGER NOT NULL DEFAULT 0 CHECK (publish_results IN (0, 1)),
  publish_feedback INTEGER NOT NULL DEFAULT 1 CHECK (publish_feedback IN (0, 1)),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rooms_classroom ON rooms(classroom_id);
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);

CREATE TABLE IF NOT EXISTS room_members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_role TEXT NOT NULL CHECK (room_role IN ('TEACHER', 'GRADER', 'STUDENT')),
  grader_weight REAL NOT NULL DEFAULT 1.0 CHECK (grader_weight > 0),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  max_capacity INTEGER NOT NULL DEFAULT 6 CHECK (max_capacity >= 1 AND max_capacity <= 100),
  presentation_order INTEGER NOT NULL DEFAULT 1,
  leader_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_locked INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (room_id, name)
);

CREATE INDEX IF NOT EXISTS idx_groups_room ON groups(room_id);

CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approval_status TEXT NOT NULL DEFAULT 'APPROVED' CHECK (approval_status IN ('APPROVED', 'PENDING')),
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

CREATE TABLE IF NOT EXISTS scoring_rubrics (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Thang điểm thuyết trình chuẩn',
  scoring_mode TEXT NOT NULL DEFAULT 'SUM' CHECK (scoring_mode IN ('SUM', 'WEIGHTED')),
  decimal_precision INTEGER NOT NULL DEFAULT 2 CHECK (decimal_precision IN (0, 1, 2)),
  max_total_score REAL NOT NULL DEFAULT 10 CHECK (max_total_score > 0 AND max_total_score <= 10),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rubric_criteria (
  id TEXT PRIMARY KEY,
  rubric_id TEXT NOT NULL REFERENCES scoring_rubrics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  min_score REAL NOT NULL DEFAULT 0 CHECK (min_score >= 0),
  max_score REAL NOT NULL CHECK (max_score > min_score),
  weight REAL NOT NULL DEFAULT 1 CHECK (weight > 0),
  sort_order INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_rubric_criteria_rubric ON rubric_criteria(rubric_id);

CREATE TABLE IF NOT EXISTS assessment_sessions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CLOSED')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  started_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_assessment_sessions_room ON assessment_sessions(room_id);

CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  grader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT', 'IN_PROGRESS', 'SUBMITTED', 'REVIEWED', 'FINALIZED')
  ),
  total_score REAL NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (room_id, group_id, grader_id)
);

CREATE INDEX IF NOT EXISTS idx_assessments_room_group ON assessments(room_id, group_id);
CREATE INDEX IF NOT EXISTS idx_assessments_grader ON assessments(grader_id);

CREATE TABLE IF NOT EXISTS assessment_scores (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL REFERENCES rubric_criteria(id) ON DELETE CASCADE,
  score REAL NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  UNIQUE (assessment_id, criterion_id)
);

CREATE INDEX IF NOT EXISTS idx_assessment_scores_assessment ON assessment_scores(assessment_id);

CREATE TABLE IF NOT EXISTS assessment_comments (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL UNIQUE REFERENCES assessments(id) ON DELETE CASCADE,
  overall_comment TEXT NOT NULL DEFAULT '',
  strengths TEXT NOT NULL DEFAULT '',
  weaknesses TEXT NOT NULL DEFAULT '',
  suggestions TEXT NOT NULL DEFAULT '',
  public_feedback TEXT NOT NULL DEFAULT '',
  private_notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assessment_revisions (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  changed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  previous_total_score REAL,
  new_total_score REAL NOT NULL,
  previous_scores_json TEXT NOT NULL,
  new_scores_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (assessment_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_assessment_revisions_assessment ON assessment_revisions(assessment_id);

CREATE TABLE IF NOT EXISTS published_results (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  final_score REAL,
  rank INTEGER,
  grader_count INTEGER NOT NULL DEFAULT 0,
  criteria_breakdown_json TEXT NOT NULL DEFAULT '{}',
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (room_id, group_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  room_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_room_id ON audit_logs(room_id);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
