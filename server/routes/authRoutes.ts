import crypto from 'node:crypto';
import { Router } from 'express';
import type { DB } from '../db.ts';
import {
  generateOpaqueToken,
  getClientIp,
  hashPassword,
  hashToken,
  rateLimitMiddleware,
  sanitizeText,
  sanitizeUsername,
  signCookieValue,
  SlidingWindowRateLimiter,
  verifyPassword,
} from '../security.ts';
import { requireAuth, writeAuditLog, type AuthedRequest } from '../middleware.ts';
import type { UserRole } from '../../src/lib/domain.ts';

export function createAuthRouter(db: DB) {
  const router = Router();

  const loginLimiter = new SlidingWindowRateLimiter(5 * 60 * 1000, 20);
  const passwordLimiter = new SlidingWindowRateLimiter(5 * 60 * 1000, 15);

  router.post(
    '/login',
    rateLimitMiddleware(
      loginLimiter,
      (req) => `${getClientIp(req)}:${sanitizeUsername(req.body?.username).toLowerCase()}`,
      'Quá nhiều lần đăng nhập thất bại. Vui lòng đợi ít phút trước khi thử lại.'
    ),
    (req, res) => {
      const username = sanitizeUsername(req.body?.username);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';

      if (!username || !password) {
        res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu.' });
        return;
      }

      const userRow = db
        .prepare(
          `SELECT u.id, u.username, u.password_hash, u.role, u.is_active, u.must_change_password,
                  p.full_name, p.student_code, p.email
           FROM users u
           LEFT JOIN profiles p ON p.user_id = u.id
           WHERE u.username = ?`
        )
        .get(username) as
        | {
            id: string;
            username: string;
            password_hash: string;
            role: UserRole;
            is_active: number;
            must_change_password: number;
            full_name: string | null;
            student_code: string | null;
            email: string | null;
          }
        | undefined;

      // Generic invalid credentials message prevents credential enumeration
      if (!userRow || !verifyPassword(password, userRow.password_hash)) {
        writeAuditLog(db, {
          actorId: userRow?.id ?? null,
          actorUsername: username,
          action: 'AUTH_LOGIN_FAILED',
          entityType: 'user',
          entityId: userRow?.id ?? username,
          details: { reason: 'invalid_credentials' },
          req,
        });
        res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' });
        return;
      }

      if (userRow.is_active !== 1) {
        writeAuditLog(db, {
          actorId: userRow.id,
          actorUsername: userRow.username,
          action: 'AUTH_LOGIN_DISABLED',
          entityType: 'user',
          entityId: userRow.id,
          req,
        });
        res.status(403).json({ error: 'Tài khoản này đã bị vô hiệu hóa. Vui lòng liên hệ giáo viên.' });
        return;
      }

      const rawToken = generateOpaqueToken();
      const tokenHash = hashToken(rawToken);
      const sessionId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      db.transaction(() => {
        db.prepare(
          `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip_address, user_agent)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          sessionId,
          userRow.id,
          tokenHash,
          expiresAt,
          getClientIp(req),
          sanitizeText(req.headers['user-agent'], 200)
        );

        db.prepare(
          `UPDATE users SET last_login_at = datetime('now'), login_count = login_count + 1, updated_at = datetime('now') WHERE id = ?`
        ).run(userRow.id);

        writeAuditLog(db, {
          actorId: userRow.id,
          actorUsername: userRow.username,
          action: 'AUTH_LOGIN_SUCCESS',
          entityType: 'user',
          entityId: userRow.id,
          req,
        });
      })();

      const isHttps =
        req.secure ||
        req.protocol === 'https' ||
        String(req.headers['x-forwarded-proto'] || '')
          .split(',')[0]
          .trim() === 'https';

      const signed = signCookieValue(rawToken);
      res.cookie('c48_session', signed, {
        httpOnly: true,
        sameSite: isHttps ? 'none' : 'lax',
        secure: isHttps,
        maxAge: 24 * 60 * 60 * 1000,
        path: '/',
      });

      res.json({
        sessionToken: signed,
        user: {
          id: userRow.id,
          username: userRow.username,
          role: userRow.role,
          fullName: userRow.full_name ?? userRow.username,
          studentCode: userRow.student_code,
          email: userRow.email,
          mustChangePassword: userRow.must_change_password === 1,
        },
      });
    }
  );

  router.post('/logout', (req: AuthedRequest, res) => {
    if (req.sessionId) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
    }
    if (req.user) {
      writeAuditLog(db, {
        actorId: req.user.id,
        actorUsername: req.user.username,
        action: 'AUTH_LOGOUT',
        entityType: 'user',
        entityId: req.user.id,
        req,
      });
    }
    const isHttps =
      req.secure ||
      req.protocol === 'https' ||
      String(req.headers['x-forwarded-proto'] || '')
        .split(',')[0]
        .trim() === 'https';
    res.clearCookie('c48_session', {
      path: '/',
      sameSite: isHttps ? 'none' : 'lax',
      secure: isHttps,
    });
    res.json({ ok: true });
  });

  router.get('/session', (req: AuthedRequest, res) => {
    res.json({ user: req.user ?? null });
  });

  router.get('/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.user });
  });

  router.post(
    '/change-password',
    requireAuth,
    rateLimitMiddleware(passwordLimiter, (req: AuthedRequest) => req.user!.id),
    (req: AuthedRequest, res) => {
      const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
      const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

      if (!currentPassword || newPassword.length < 6) {
        res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự.' });
        return;
      }

      const row = db
        .prepare('SELECT password_hash FROM users WHERE id = ?')
        .get(req.user!.id) as { password_hash: string } | undefined;

      if (!row || !verifyPassword(currentPassword, row.password_hash)) {
        res.status(400).json({ error: 'Mật khẩu hiện tại không chính xác.' });
        return;
      }

      const newHash = hashPassword(newPassword);
      db.transaction(() => {
        db.prepare(
          `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`
        ).run(newHash, req.user!.id);

        if (req.sessionId) {
          db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(
            req.user!.id,
            req.sessionId
          );
        }

        writeAuditLog(db, {
          actorId: req.user!.id,
          actorUsername: req.user!.username,
          action: 'AUTH_PASSWORD_CHANGED',
          entityType: 'user',
          entityId: req.user!.id,
          req,
        });
      })();

      res.json({ ok: true });
    }
  );

  return router;
}
