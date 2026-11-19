const AUTH_TOKEN_KEY = 'c48_auth_token';
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\\/$/, '');
function apiUrl(url: string): string { return url.startsWith('http') ? url : `${API_BASE}${url}`; }

export function getAuthToken(): string | null {
  try {
    return window.sessionStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null): void {
  try {
    if (token) {
      window.sessionStorage.setItem(AUTH_TOKEN_KEY, token);
    } else {
      window.sessionStorage.removeItem(AUTH_TOKEN_KEY);
    }
  } catch {
    // Ignore storage access errors in restricted frames
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T = any>(
  url: string,
  options: RequestInit & { retries?: number } = {}
): Promise<T> {
  const { retries = 0, headers, ...rest } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const token = getAuthToken();
      const res = await fetch(apiUrl(url), {
        ...rest,
        credentials: 'same-origin',
        headers: {
          ...(rest.body && !(rest.body instanceof FormData)
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      });

      const contentType = res.headers.get('content-type') || '';
      const payload = contentType.includes('application/json')
        ? await res.json()
        : await res.text();

      if (!res.ok) {
        if (
          res.status === 401 &&
          typeof window !== 'undefined' &&
          !url.startsWith('/api/auth/login') &&
          !url.startsWith('/api/auth/session')
        ) {
          setAuthToken(null);
          window.dispatchEvent(new CustomEvent('c48:unauthorized'));
        }
        const msg =
          typeof payload === 'object' && payload && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : `Lỗi máy chủ (${res.status})`;
        throw new ApiError(msg, res.status, payload);
      }

      return payload as T;
    } catch (err) {
      lastError = err;
      if (err instanceof ApiError && err.status < 500) {
        throw err;
      }
      if (attempt < retries) {
        const delay = Math.min(2000, 250 * Math.pow(2, attempt) + Math.random() * 150);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Không thể kết nối đến máy chủ. Vui lòng kiểm tra mạng.');
}

export async function downloadAuthenticatedFile(
  url: string,
  fallbackFilename: string
): Promise<void> {
  const token = getAuthToken();
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });

  if (!res.ok) {
    let msg = `Không thể tải tệp (${res.status})`;
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload?.error) msg = payload.error;
    } catch {
      // Ignore non-JSON error body
    }
    if (res.status === 401 && typeof window !== 'undefined') {
      setAuthToken(null);
      window.dispatchEvent(new CustomEvent('c48:unauthorized'));
    }
    throw new ApiError(msg, res.status);
  }

  const disposition = res.headers.get('content-disposition') || '';
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plainMatch = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = utf8Match?.[1]
    ? decodeURIComponent(utf8Match[1])
    : plainMatch?.[1] || fallbackFilename;

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export function formatViDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d);
}
