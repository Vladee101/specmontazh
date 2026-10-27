// Обёртка над API: JSON, cookie сессии, CSRF-токен для изменяющих запросов,
// единый формат ошибок { code, message, field_errors }.

export type FieldErrors = Record<string, string>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: FieldErrors = {},
    readonly details?: any,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'Нет связи с сервером. Проверьте подключение.');
  }
  if (res.status === 204) return undefined as T;
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') onUnauthorized?.();
    throw new ApiError(res.status, data?.code ?? 'error', data?.message ?? `Ошибка ${res.status}`, data?.field_errors ?? {}, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T = any>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  patch: <T = any>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  del: <T = any>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/** Строка запроса без пустых значений. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}
