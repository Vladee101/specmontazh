import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, setCsrfToken, setUnauthorizedHandler } from './api';
import type { Role } from './labels';

export interface User {
  id: number;
  login: string;
  full_name: string;
  role: Role;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  login(login: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setUser(null);
    });
    api
      .get<{ user: User; csrf_token: string }>('/auth/me')
      .then((r) => {
        setCsrfToken(r.csrf_token);
        setUser(r.user);
      })
      .catch((e) => {
        if (!(e instanceof ApiError) || e.status !== 401) console.error(e);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (loginName: string, password: string) => {
    const r = await api.post<{ user: User; csrf_token: string }>('/auth/login', { login: loginName, password });
    setCsrfToken(r.csrf_token);
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setCsrfToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth вне AuthProvider');
  return ctx;
}

export function useUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error('нет пользователя');
  return user;
}
