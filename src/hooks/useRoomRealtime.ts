import { useEffect, useRef, useState } from 'react';
import { getAuthToken } from '../lib/api';

export type ConnectionState = 'connected' | 'connecting' | 'offline';

interface RealtimeEnvelope {
  eventId?: string;
  type: string;
  roomId?: string;
  payload?: Record<string, unknown>;
}

export function useRoomRealtime(
  roomId: string | undefined,
  onSyncEvent: (eventType: string, payload?: Record<string, unknown>) => void
) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const callbackRef = useRef(onSyncEvent);
  callbackRef.current = onSyncEvent;

  useEffect(() => {
    if (!roomId) {
      setConnectionState('offline');
      return;
    }

    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let attempt = 0;
    const seenEvents = new Set<string>();

    const connect = () => {
      if (disposed) return;
      setConnectionState('connecting');

      const base = (import.meta.env.VITE_API_BASE_URL || window.location.origin).replace(/\\/$/, '');
      const wsBase = base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
      const token = getAuthToken();
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      ws = new WebSocket(`${wsBase}/ws${qs}`);

      ws.onopen = () => {
        if (disposed) return;
        const wasReconnect = attempt > 0;
        attempt = 0;
        setConnectionState('connected');
        ws?.send(JSON.stringify({ type: 'subscribe:room', roomId }));
        if (wasReconnect) {
          // Authoritative revalidation after reconnect
          callbackRef.current('reconnected');
        }
        pingTimer = window.setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25_000);
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data) as RealtimeEnvelope;
          if (data.eventId) {
            if (seenEvents.has(data.eventId)) return;
            seenEvents.add(data.eventId);
            if (seenEvents.size > 200) {
              const first = seenEvents.values().next().value;
              if (first) seenEvents.delete(first);
            }
          }
          if (
            data.type === 'room:updated' ||
            data.type === 'group:updated' ||
            data.type === 'assessment:updated' ||
            data.type === 'results:published'
          ) {
            callbackRef.current(data.type, data.payload);
          }
        } catch {
          // Ignore malformed WS message
        }
      };

      ws.onclose = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (disposed) return;
        setConnectionState('offline');
        const delay = Math.min(12_000, 600 * Math.pow(2, attempt) + Math.random() * 400);
        attempt++;
        reconnectTimer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    const handleOnline = () => {
      if (ws?.readyState !== WebSocket.OPEN) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        connect();
      } else {
        callbackRef.current('reconnected');
      }
    };

    window.addEventListener('online', handleOnline);
    connect();

    return () => {
      disposed = true;
      window.removeEventListener('online', handleOnline);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'unsubscribe:room', roomId }));
        }
        ws.close();
      }
    };
  }, [roomId]);

  return { connectionState };
}
