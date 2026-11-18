import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import toast from 'react-hot-toast';

import { api, eventsUrl } from '@/lib/api';
import type {
  AccountView,
  Bootstrap,
  CoreEvent,
  Settings,
  TransferView,
  VolumeView,
} from '@/lib/types';

const ACTIVE_ACCOUNT_KEY = 'wcdc.active-account';
const THEME_KEY = 'wcdc.theme';

type ThemeMode = 'light' | 'dark';

interface AppContextValue {
  loading: boolean;
  error: string | null;
  accounts: AccountView[];
  activeAccount: AccountView | null;
  activeAccountId: string | null;
  volumes: VolumeView[];
  settings: Settings | null;
  transfers: TransferView[];
  dataDir: string;
  theme: ThemeMode;
  setActiveAccountId: (id: string) => void;
  setTheme: (theme: ThemeMode) => void;
  refresh: () => Promise<void>;
  refreshTransfers: () => Promise<void>;
  refreshVolumes: () => Promise<void>;
  saveSettings: (patch: {
    downloadDir?: string;
    concurrency?: number;
    maxSpeedBps?: number;
    theme?: string;
    lanOnly?: boolean;
  }) => Promise<void>;
  logout: (accountId: string) => Promise<void>;
  refreshAccount: (accountId: string) => Promise<void>;
  quarkLoginOpen: boolean;
  quarkLoginNext: string | null;
  openQuarkLogin: (nextPath?: string) => void;
  closeQuarkLogin: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

function readStoredTheme(): ThemeMode {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [transfers, setTransfers] = useState<TransferView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setThemeState] = useState<ThemeMode>(readStoredTheme);
  const [activeAccountId, setActiveAccountIdState] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_ACCOUNT_KEY)
  );
  const [quarkLoginOpen, setQuarkLoginOpen] = useState(false);
  const [quarkLoginNext, setQuarkLoginNext] = useState<string | null>(null);
  const accountsRef = useRef<AccountView[]>([]);
  const activeRef = useRef<string | null>(activeAccountId);

  accountsRef.current = bootstrap?.accounts ?? [];
  activeRef.current = activeAccountId;

  const applyTheme = useCallback((next: ThemeMode) => {
    document.documentElement.classList.toggle('dark', next === 'dark');
    document.documentElement.style.colorScheme = next;
    localStorage.setItem(THEME_KEY, next);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [applyTheme, theme]);

  const setTheme = useCallback(
    (next: ThemeMode) => {
      setThemeState(next);
      applyTheme(next);
      void api.updateSettings({ theme: next }).catch(() => undefined);
    },
    [applyTheme]
  );

  const reconcileActive = useCallback((accounts: AccountView[]) => {
    const current = activeRef.current;
    const next =
      (current && accounts.some((account) => account.id === current)
        ? current
        : accounts[0]?.id) ?? null;
    if (next !== current) {
      setActiveAccountIdState(next);
      if (next) localStorage.setItem(ACTIVE_ACCOUNT_KEY, next);
      else localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api.bootstrap();
      setBootstrap(data);
      setTransfers(data.transfers);
      reconcileActive(data.accounts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [reconcileActive]);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const refreshTransfers = useCallback(async () => {
    try {
      const list = await api.listTransfers();
      setTransfers(list);
    } catch {
      // transient errors are surfaced by the page that needs them
    }
  }, []);

  const refreshVolumes = useCallback(async () => {
    try {
      const { volumes } = await api.volumes();
      setBootstrap((current) => (current ? { ...current, volumes } : current));
    } catch {
      // ignore
    }
  }, []);

  const saveSettings = useCallback(
    async (patch: {
      downloadDir?: string;
      concurrency?: number;
      maxSpeedBps?: number;
      theme?: string;
      lanOnly?: boolean;
    }) => {
      const settings = await api.updateSettings(patch);
      setBootstrap((current) =>
        current ? { ...current, settings } : current
      );
      if (settings.theme === 'light' || settings.theme === 'dark') {
        setThemeState(settings.theme);
        applyTheme(settings.theme);
      }
    },
    [applyTheme]
  );

  const setActiveAccountId = useCallback((id: string) => {
    setActiveAccountIdState(id);
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, id);
  }, []);

  const logout = useCallback(
    async (accountId: string) => {
      await api.logout(accountId);
      await refresh();
      toast.success('已退出该账号');
    },
    [refresh]
  );

  const refreshAccount = useCallback(
    async (accountId: string) => {
      const account = await api.refreshAccount(accountId);
      setBootstrap((current) => {
        if (!current) return current;
        return {
          ...current,
          accounts: current.accounts.map((item) =>
            item.id === account.id ? account : item
          ),
        };
      });
    },
    []
  );

  const openQuarkLogin = useCallback((nextPath?: string) => {
    setQuarkLoginNext(nextPath ?? null);
    setQuarkLoginOpen(true);
  }, []);

  const closeQuarkLogin = useCallback(() => {
    setQuarkLoginOpen(false);
    setQuarkLoginNext(null);
  }, []);

  useEffect(() => {
    const handler = () => openQuarkLogin(window.location.pathname);
    window.addEventListener('wcdc:quark-auth-required', handler);
    return () =>
      window.removeEventListener('wcdc:quark-auth-required', handler);
  }, [openQuarkLogin]);

  useEffect(() => {
    const source = new EventSource(eventsUrl, { withCredentials: true });
    source.onmessage = (message) => {
      let event: CoreEvent;
      try {
        event = JSON.parse(message.data) as CoreEvent;
      } catch {
        return;
      }
      switch (event.type) {
        case 'accountsChanged': {
          const accounts = (event.accounts as AccountView[]) ?? [];
          setBootstrap((current) =>
            current ? { ...current, accounts } : current
          );
          reconcileActive(accounts);
          break;
        }
        case 'transferProgress': {
          const id = String(event.id ?? '');
          if (!id) break;
          setTransfers((current) => {
            const index = current.findIndex((item) => item.id === id);
            if (index < 0) return current;
            const next = current.slice();
            next[index] = {
              ...next[index],
              status: String(event.status ?? next[index].status),
              phase: String(event.phase ?? next[index].phase),
              doneBytes: Number(event.doneBytes ?? next[index].doneBytes),
              totalBytes: Number(event.totalBytes ?? next[index].totalBytes),
              speedBps: Number(event.speedBps ?? next[index].speedBps),
            };
            return next;
          });
          break;
        }
        case 'transferChanged': {
          const transfer = event.transfer as TransferView | undefined;
          if (!transfer) break;
          setTransfers((current) => {
            const index = current.findIndex((item) => item.id === transfer.id);
            if (index < 0) return [transfer, ...current];
            const next = current.slice();
            next[index] = transfer;
            return next;
          });
          break;
        }
        case 'toast': {
          const text = String(event.message ?? '');
          if (!text) break;
          if (event.level === 'error') toast.error(text);
          else if (event.level === 'warn') toast(text);
          else toast.success(text);
          break;
        }
        default:
          break;
      }
    };
    source.onerror = () => {
      // EventSource reconnects automatically; a full refresh covers missed events.
      void refreshTransfers();
    };
    return () => source.close();
  }, [reconcileActive, refreshTransfers]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshTransfers();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshTransfers]);

  const activeAccount = useMemo(
    () =>
      bootstrap?.accounts.find((account) => account.id === activeAccountId) ??
      bootstrap?.accounts[0] ??
      null,
    [bootstrap, activeAccountId]
  );

  const value: AppContextValue = {
    loading,
    error,
    accounts: bootstrap?.accounts ?? [],
    activeAccount,
    activeAccountId: activeAccount?.id ?? null,
    volumes: bootstrap?.volumes ?? [],
    settings: bootstrap?.settings ?? null,
    transfers,
    dataDir: bootstrap?.dataDir ?? '',
    theme,
    setActiveAccountId,
    setTheme,
    refresh,
    refreshTransfers,
    refreshVolumes,
    saveSettings,
    logout,
    refreshAccount,
    quarkLoginOpen,
    quarkLoginNext,
    openQuarkLogin,
    closeQuarkLogin,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return context;
}
