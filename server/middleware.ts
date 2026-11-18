import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { DB } from './db.ts';
import type { UserRole } from '../src/lib/domain.ts';
import { extractBearerToken, getClientIp, hashToken, parseCookies, verifyCookieValue } from './security.ts';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  fullName: string;
  studentCode: string | null;
  email: string | null;
  mustChangePassword: boolean;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
  sessionId?: string;
}

export function authenticateMiddleware(db: DB) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    const cookies = parseCookies(req.headers.cookie);
    const bearer = extractBearerToken(req.headers.authorization);
    const rawToken = verifyCookieValue(cookies['c48_session']) || verifyCookieValue(bearer);
    if (!rawToken) {
      next();
      return;
    }

    const tokenHash = hashToken(rawToken);
    const row = db
      .prepare(
        `SELECT s.id as session_id, u.id, u.username, u.role, u.is_active, u.must_change_password,
                p.full_name, p.student_code, p.email
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
      )
      .get(tokenHash) as
      | {
          session_id: string;
          id: string;
          username: string;
          role: UserRole;
          is_active: number;
          must_change_password: number;
          full_name: string | null;
          student_code: string | null;
          email: string | null;
        }
      | undefined;

    if (row && row.is_active === 1) {
      req.user = {
        id: row.id,
        username: row.username,
        role: row.role,
        fullName: row.full_name ?? row.username,
        studentCode: row.student_code,
        email: row.email,
        mustChangePassword: row.must_change_password === 1,
      };
      req.sessionId = row.session_id;
    }
    next();
  };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn hoặc chưa đăng nhập.' });
    return;
  }
  next();
}

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Vui lòng đăng nhập để tiếp tục.' });
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này.' });
      return;
    }
    next();
  };
}

export function writeAuditLog(
  db: DB,
  params: {
    actorId?: string | null;
    actorUsername?: string;
    action: string;
    entityType: string;
    entityId: string;
    roomId?: string | null;
    details?: Record<string, unknown>;
    req?: Request;
  }
): void {
  db.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_username, action, entity_type, entity_id, room_id, details_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    params.actorId ?? null,
    params.actorUsername ?? 'system',
    params.action,
    params.entityType,
    params.entityId,
    params.roomId ?? null,
    JSON.stringify(params.details ?? {}),
    params.req ? getClientIp(params.req) : ''
  );
}

export function canAccessRoom(db: DB, user: AuthUser, roomId: string): boolean {
  if (user.role === 'SUPER_ADMIN' || user.role === 'TEACHER') {
    return true;
  }
  const membership = db
    .prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(roomId, user.id);
  return Boolean(membership);
}
