import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

import { api } from '@/lib/api';
import type { AuthStatus } from '@/lib/types';

interface AuthContextValue {
  status: AuthStatus | null;
  refresh: () => Promise<AuthStatus>;
  register: (password: string) => Promise<void>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);

  const refresh = useCallback(async () => {
    const next = await api.authStatus();
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    refresh().catch(() => {
      setStatus({ registered: true, authenticated: false });
    });
  }, [refresh]);

  useEffect(() => {
    const handleUnauthorized = () => {
      setStatus((current) =>
        current
          ? { ...current, authenticated: false }
          : { registered: true, authenticated: false }
      );
    };
    window.addEventListener('wcdc:unauthorized', handleUnauthorized);
    return () =>
      window.removeEventListener('wcdc:unauthorized', handleUnauthorized);
  }, []);

  const register = useCallback(async (password: string) => {
    const next = await api.authRegister(password);
    setStatus(next);
  }, []);

  const login = useCallback(async (password: string) => {
    const next = await api.authLogin(password);
    setStatus(next);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.authLogout();
    } finally {
      setStatus((current) => ({
        registered: current?.registered ?? true,
        authenticated: false,
      }));
    }
  }, []);

  return (
    <AuthContext.Provider value={{ status, refresh, register, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return context;
}
