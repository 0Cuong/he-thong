-- Classroom 48 — PostgreSQL / Supabase Production Schema with Row-Level Security (RLS)
-- Apply via `supabase db push` or `psql` when deploying to managed PostgreSQL / Supabase.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'TEACHER', 'GRADER', 'STUDENT');
CREATE TYPE classroom_status AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE room_status AS ENUM (
  'DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'READY',
  'IN_PROGRESS', 'PAUSED', 'FINALIZED', 'ARCHIVED'
);
CREATE TYPE assessment_status AS ENUM ('DRAFT', 'IN_PROGRESS', 'SUBMITTED', 'REVIEWED', 'FINALIZED');
CREATE TYPE scoring_mode AS ENUM ('SUM', 'WEIGHTED');
CREATE TYPE multi_grader_policy AS ENUM ('AVERAGE', 'WEIGHTED_AVERAGE');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'STUDENT',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  login_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  student_code TEXT,
  email TEXT,
  phone TEXT,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE classrooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  academic_year TEXT NOT NULL DEFAULT '2026-2027',
  description TEXT NOT NULL DEFAULT '',
  status classroom_status NOT NULL DEFAULT 'ACTIVE',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE classroom_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL CHECK (member_role IN ('TEACHER', 'GRADER', 'STUDENT')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (classroom_id, user_id)
);

CREATE TABLE rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  room_code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  session_date DATE NOT NULL,
  status room_status NOT NULL DEFAULT 'DRAFT',
  allow_student_selection BOOLEAN NOT NULL DEFAULT TRUE,
  require_admin_approval BOOLEAN NOT NULL DEFAULT FALSE,
  lock_groups_on_start BOOLEAN NOT NULL DEFAULT TRUE,
  multi_grader_policy multi_grader_policy NOT NULL DEFAULT 'AVERAGE',
  publish_results BOOLEAN NOT NULL DEFAULT FALSE,
  publish_feedback BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE room_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_role TEXT NOT NULL CHECK (room_role IN ('TEACHER', 'GRADER', 'STUDENT')),
  grader_weight NUMERIC(5,2) NOT NULL DEFAULT 1.0 CHECK (grader_weight > 0),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, user_id)
);

CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  max_capacity INTEGER NOT NULL DEFAULT 6 CHECK (max_capacity BETWEEN 1 AND 100),
  presentation_order INTEGER NOT NULL DEFAULT 1,
  leader_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, name)
);

CREATE TABLE group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approval_status TEXT NOT NULL DEFAULT 'APPROVED' CHECK (approval_status IN ('APPROVED', 'PENDING')),
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, user_id)
);

CREATE TABLE scoring_rubrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Thang điểm thuyết trình chuẩn',
  scoring_mode scoring_mode NOT NULL DEFAULT 'SUM',
  decimal_precision SMALLINT NOT NULL DEFAULT 1 CHECK (decimal_precision IN (0, 1, 2)),
  max_total_score NUMERIC(8,2) NOT NULL DEFAULT 100 CHECK (max_total_score > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE rubric_criteria (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric_id UUID NOT NULL REFERENCES scoring_rubrics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  min_score NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (min_score >= 0),
  max_score NUMERIC(8,2) NOT NULL CHECK (max_score > min_score),
  weight NUMERIC(8,2) NOT NULL DEFAULT 1 CHECK (weight > 0),
  sort_order INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE assessment_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CLOSED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  started_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  grader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status assessment_status NOT NULL DEFAULT 'DRAFT',
  total_score NUMERIC(8,2) NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, group_id, grader_id)
);

CREATE TABLE assessment_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  criterion_id UUID NOT NULL REFERENCES rubric_criteria(id) ON DELETE CASCADE,
  score NUMERIC(8,2) NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  UNIQUE (assessment_id, criterion_id)
);

CREATE TABLE assessment_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID NOT NULL UNIQUE REFERENCES assessments(id) ON DELETE CASCADE,
  overall_comment TEXT NOT NULL DEFAULT '',
  strengths TEXT NOT NULL DEFAULT '',
  weaknesses TEXT NOT NULL DEFAULT '',
  suggestions TEXT NOT NULL DEFAULT '',
  public_feedback TEXT NOT NULL DEFAULT '',
  private_notes TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE assessment_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  changed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  previous_total_score NUMERIC(8,2),
  new_total_score NUMERIC(8,2) NOT NULL,
  previous_scores_json JSONB NOT NULL,
  new_scores_json JSONB NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (assessment_id, revision_number)
);

CREATE TABLE published_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  final_score NUMERIC(8,2),
  rank INTEGER,
  grader_count INTEGER NOT NULL DEFAULT 0,
  criteria_breakdown_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (room_id, group_id)
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  room_id UUID,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Atomic seat-reservation function preventing race conditions
CREATE OR REPLACE FUNCTION join_group_atomic(p_room_id UUID, p_group_id UUID, p_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_capacity INTEGER;
  v_current INTEGER;
  v_room_status room_status;
  v_allow_sel BOOLEAN;
  v_require_approval BOOLEAN;
BEGIN
  SELECT status, allow_student_selection, require_admin_approval
    INTO v_room_status, v_allow_sel, v_require_approval
  FROM rooms WHERE id = p_room_id FOR SHARE;

  IF v_room_status <> 'REGISTRATION_OPEN' OR NOT v_allow_sel THEN
    RAISE EXCEPTION 'REGISTRATION_CLOSED';
  END IF;

  SELECT max_capacity INTO v_capacity FROM groups WHERE id = p_group_id AND room_id = p_room_id FOR UPDATE;
  SELECT COUNT(*) INTO v_current FROM group_members WHERE group_id = p_group_id;

  IF v_current >= v_capacity THEN
    RAISE EXCEPTION 'GROUP_FULL';
  END IF;

  DELETE FROM group_members WHERE room_id = p_room_id AND user_id = p_user_id;

  INSERT INTO group_members (room_id, group_id, user_id, approval_status)
  VALUES (p_room_id, p_group_id, p_user_id, CASE WHEN v_require_approval THEN 'PENDING' ELSE 'APPROVED' END);
END;
$$;

-- Enable Row-Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Example RLS Policies (auth.uid() mapped to users.id)
CREATE POLICY student_own_profile ON profiles
  FOR SELECT USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('SUPER_ADMIN', 'TEACHER')));

CREATE POLICY grader_own_assessments ON assessments
  FOR ALL USING (
    grader_id = auth.uid() OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('SUPER_ADMIN', 'TEACHER'))
  );

CREATE POLICY hide_private_comments_from_students ON assessment_comments
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('SUPER_ADMIN', 'TEACHER', 'GRADER'))
  );
