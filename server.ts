import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { openDatabase } from './server/db.ts';
import { RealtimeHub } from './server/realtime.ts';
import { createApp } from './server/app.ts';

async function startServer() {
  const db = openDatabase();
  const realtime = new RealtimeHub();
  const app = createApp(db, realtime);

  const server = http.createServer(app);
  realtime.attach(server, db);

  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`Classroom 48 server running at http://0.0.0.0:${port}`);
  });

  const shutdown = () => {
    realtime.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
