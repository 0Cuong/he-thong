import type { Server as HttpServer, IncomingMessage } from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { DB } from './db.ts';
import { parseCookies, verifyCookieValue, hashToken } from './security.ts';

export type RealtimeEventType =
  | 'room:updated'
  | 'group:updated'
  | 'assessment:updated'
  | 'results:published';

export interface RealtimeMessage {
  eventId: string;
  type: RealtimeEventType;
  roomId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface AuthedSocket extends WebSocket {
  userId?: string;
  role?: string;
  subscribedRooms: Set<string>;
  isAlive: boolean;
}

export class RealtimeHub {
  private wss: WebSocketServer | null = null;
  private roomSockets = new Map<string, Set<AuthedSocket>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  attach(server: HttpServer, db: DB): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const urlPath = (req.url || '').split('?')[0];
      if (urlPath !== '/ws') {
        return;
      }

      const cookies = parseCookies(req.headers.cookie);
      let queryToken: string | undefined;
      try {
        const parsedUrl = new URL(req.url || '/ws', 'http://localhost');
        queryToken = parsedUrl.searchParams.get('token') ?? undefined;
      } catch {
        queryToken = undefined;
      }
      const rawToken = verifyCookieValue(cookies['c48_session']) || verifyCookieValue(queryToken);
      if (!rawToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const tokenHash = hashToken(rawToken);
      const session = db
        .prepare(
          `SELECT s.user_id, u.role, u.is_active
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
        )
        .get(tokenHash) as { user_id: string; role: string; is_active: number } | undefined;

      if (!session || session.is_active !== 1) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const authed = ws as AuthedSocket;
        authed.userId = session.user_id;
        authed.role = session.role;
        authed.subscribedRooms = new Set();
        authed.isAlive = true;
        this.wss!.emit('connection', authed, req);
      });
    });

    this.wss.on('connection', (ws: AuthedSocket) => {
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; roomId?: string };
          if (msg.type === 'subscribe:room' && typeof msg.roomId === 'string') {
            this.subscribe(ws, msg.roomId, db);
          } else if (msg.type === 'unsubscribe:room' && typeof msg.roomId === 'string') {
            this.unsubscribe(ws, msg.roomId);
          } else if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          }
        } catch {
          // Ignore malformed client frames
        }
      });

      ws.on('close', () => {
        for (const roomId of ws.subscribedRooms) {
          this.roomSockets.get(roomId)?.delete(ws);
        }
        ws.subscribedRooms.clear();
      });

      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
    });

    this.heartbeatTimer = setInterval(() => {
      if (!this.wss) return;
      for (const client of this.wss.clients) {
        const ws = client as AuthedSocket;
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30_000);
  }

  private subscribe(ws: AuthedSocket, roomId: string, db: DB): void {
    if (!ws.userId) return;
    // Verify room access before subscribing
    if (ws.role !== 'SUPER_ADMIN' && ws.role !== 'TEACHER') {
      const member = db
        .prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?')
        .get(roomId, ws.userId);
      if (!member) return;
    }

    if (!this.roomSockets.has(roomId)) {
      this.roomSockets.set(roomId, new Set());
    }
    this.roomSockets.get(roomId)!.add(ws);
    ws.subscribedRooms.add(roomId);
    ws.send(JSON.stringify({ type: 'subscribed', roomId }));
  }

  private unsubscribe(ws: AuthedSocket, roomId: string): void {
    this.roomSockets.get(roomId)?.delete(ws);
    ws.subscribedRooms.delete(roomId);
  }

  broadcast(roomId: string, type: RealtimeEventType, payload: Record<string, unknown> = {}): void {
    const sockets = this.roomSockets.get(roomId);
    if (!sockets || sockets.size === 0) return;

    const message: RealtimeMessage = {
      eventId: crypto.randomUUID(),
      type,
      roomId,
      timestamp: new Date().toISOString(),
      payload,
    };
    const serialized = JSON.stringify(message);

    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serialized);
      }
    }
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.wss?.close();
    this.roomSockets.clear();
  }
}
