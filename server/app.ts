import express from 'express';
import type { DB } from './db.ts';
import type { RealtimeHub } from './realtime.ts';
import { authenticateMiddleware } from './middleware.ts';
import { createAuthRouter } from './routes/authRoutes.ts';
import { createAdminRouter } from './routes/adminRoutes.ts';
import { createRoomRouter } from './routes/roomRoutes.ts';
import { createAssessmentRouter } from './routes/assessmentRoutes.ts';

export function createApp(db: DB, realtime: RealtimeHub) {
  const app = express();

  app.set('trust proxy', 1);

  // Allow the configured Vercel frontend to call the API cross-origin.\n  const allowedOrigin = process.env.FRONTEND_URL;\n  app.use((req, res, next) => {\n    const origin = req.headers.origin;\n    if (origin && allowedOrigin && origin === allowedOrigin) {\n      res.setHeader('Access-Control-Allow-Origin', origin);\n      res.setHeader('Access-Control-Allow-Credentials', 'true');\n      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');\n      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');\n      res.setHeader('Vary', 'Origin');\n    }\n    if (req.method === 'OPTIONS') return res.sendStatus(204);\n    next();\n  });\n\n  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');
    next();
  });

  app.use(express.json({ limit: '6mb' }));
  app.use(authenticateMiddleware(db));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/auth', createAuthRouter(db));
  app.use('/api', createAdminRouter(db));
  app.use('/api', createRoomRouter(db, realtime));
  app.use('/api', createAssessmentRouter(db, realtime));

  // Unmatched API endpoints return JSON 404
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Không tìm thấy endpoint API yêu cầu.' });
  });

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error('Unhandled API error:', err);
      res.status(500).json({ error: 'Lỗi hệ thống nội bộ. Vui lòng thử lại sau.' });
    }
  );

  return app;
}
