import type {
  AccountView,
  AuthStatus,
  Bootstrap,
  BrowseResult,
  CreateImageJobsRequest,
  CreateJobsRequest,
  DownloadItem,
  FileBrowseResult,
  HistoryRecord,
  ImageJobView,
  ImageScanResult,
  JobView,
  ListResult,
  LogsResult,
  QrLoginPoll,
  QrLoginStart,
  QueueState,
  RecycleListResult,
  ScanProgress,
  ScanResult,
  ServerInfo,
  Settings,
  StorageRoots,
  TransferView,
  TranscodeStats,
  TranscodeStatus,
  VolumeView,
} from './types';
import { API_BASE, APP_BASE } from './base';

const BASE = API_BASE;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`;
    let code: string | undefined;
    try {
      const body = await response.json();
      if (typeof body?.error === 'string' && body.error) {
        message = body.error;
      }
      if (typeof body?.code === 'string') {
        code = body.code;
      }
    } catch {
      // ignore non-JSON error bodies
    }
    if (response.status === 401 && code === 'site_auth_required') {
      window.dispatchEvent(new Event('wcdc:unauthorized'));
    }
    if (code === 'quark_auth_required') {
      window.dispatchEvent(new Event('wcdc:quark-auth-required'));
    }
    throw new Error(message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}

export const api = {
  authStatus: () => request<AuthStatus>('/auth/status'),
  authRegister: (password: string) =>
    request<AuthStatus>('/auth/register', {
      method: 'POST',
      ...jsonBody({ password }),
    }),
  authLogin: (password: string) =>
    request<AuthStatus>('/auth/login', {
      method: 'POST',
      ...jsonBody({ password }),
    }),
  authLogout: () =>
    request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  logs: (params: { limit?: number; level?: string; contains?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.limit) search.set('limit', String(params.limit));
    if (params.level) search.set('level', params.level);
    if (params.contains) search.set('contains', params.contains);
    const query = search.toString();
    return request<LogsResult>(`/logs${query ? `?${query}` : ''}`);
  },
  clearLogs: () =>
    request<{ ok: boolean }>('/logs', { method: 'DELETE' }),
  serverInfo: () => request<ServerInfo>('/server/info'),
  transcodeStatus: (refresh = false) =>
    request<TranscodeStatus>(`/transcode/status${refresh ? '?refresh=1' : ''}`),
  transcodeSetPath: (path: string | null) =>
    request<TranscodeStatus>('/transcode/path', {
      method: 'POST',
      ...jsonBody({ path }),
    }),
  transcodeSelfTest: () =>
    request<TranscodeStatus>('/transcode/self-test', { method: 'POST' }),
  transcodeCached: () =>
    request<{ status: TranscodeStatus | null }>('/transcode/cached'),
  transcodeScan: (payload: {
    directory: string;
    recursive: boolean;
    sourceCodec?: string | null;
    minSizeBytes?: number | null;
  }) =>
    request<ScanResult>('/transcode/scan', {
      method: 'POST',
      ...jsonBody(payload),
    }),
  transcodeScanProgress: () =>
    request<ScanProgress>('/transcode/scan/progress'),
  transcodeJobs: () => request<JobView[]>('/transcode/jobs'),
  transcodeCreateJobs: (payload: CreateJobsRequest) =>
    request<JobView[]>('/transcode/jobs', {
      method: 'POST',
      ...jsonBody(payload),
    }),
  transcodeCancelJob: (id: string) =>
    request<{ ok: boolean }>(
      `/transcode/jobs/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' }
    ),
  transcodeRetryJob: (id: string) =>
    request<JobView[]>(
      `/transcode/jobs/${encodeURIComponent(id)}/retry`,
      { method: 'POST' }
    ),
  transcodeClearJobs: () =>
    request<{ removed: number }>('/transcode/jobs', { method: 'DELETE' }),
  transcodeQueueState: () => request<QueueState>('/transcode/queue'),
  transcodePauseAll: () =>
    request<{ paused: boolean; affected: number }>(
      '/transcode/jobs/pause-all',
      { method: 'POST' }
    ),
  transcodeResumeAll: () =>
    request<{ paused: boolean; affected: number }>(
      '/transcode/jobs/resume-all',
      { method: 'POST' }
    ),
  transcodeCancelAll: () =>
    request<{ canceled: number }>('/transcode/jobs/cancel-all', {
      method: 'POST',
    }),
  transcodeStats: () => request<TranscodeStats>('/transcode/stats'),

  imageScan: (payload: {
    directory: string;
    recursive: boolean;
    minSizeBytes?: number | null;
  }) =>
    request<ImageScanResult>('/images/scan', {
      method: 'POST',
      ...jsonBody(payload),
    }),
  imageJobs: () => request<ImageJobView[]>('/images/jobs'),
  imageCreateJobs: (payload: CreateImageJobsRequest) =>
    request<ImageJobView[]>('/images/jobs', {
      method: 'POST',
      ...jsonBody(payload),
    }),
  imageCancelJob: (id: string) =>
    request<{ ok: boolean }>(`/images/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    }),
  imageRetryJob: (id: string) =>
    request<ImageJobView[]>(`/images/jobs/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    }),
  imageClearJobs: () =>
    request<{ removed: number }>('/images/jobs', { method: 'DELETE' }),
  imageQueueState: () => request<QueueState>('/images/queue'),
  imagePauseAll: () =>
    request<{ paused: boolean; affected: number }>('/images/jobs/pause-all', {
      method: 'POST',
    }),
  imageResumeAll: () =>
    request<{ paused: boolean; affected: number }>('/images/jobs/resume-all', {
      method: 'POST',
    }),
  imageCancelAll: () =>
    request<{ canceled: number }>('/images/jobs/cancel-all', {
      method: 'POST',
    }),
  history: (limit = 100) =>
    request<HistoryRecord[]>(`/history?limit=${limit}`),
  clearHistory: () =>
    request<{ removed: number }>('/history', { method: 'DELETE' }),

  bootstrap: () => request<Bootstrap>('/bootstrap'),
  volumes: () => request<{ volumes: VolumeView[] }>('/volumes'),
  storageRoots: () => request<StorageRoots>('/storage/roots'),
  browseStorage: (path?: string) =>
    request<BrowseResult>(
      `/storage/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`
    ),
  mkdirStorage: (path: string, name: string) =>
    request<{ path: string }>('/storage/mkdir', {
      method: 'POST',
      ...jsonBody({ path, name }),
    }),
  serverFiles: (path?: string) =>
    request<FileBrowseResult>(
      `/storage/files${path ? `?path=${encodeURIComponent(path)}` : ''}`
    ),
  serverFileUrl: (path: string) =>
    `${APP_BASE}/api/storage/file?path=${encodeURIComponent(path)}`,

  startQrLogin: () =>
    request<QrLoginStart>('/login/qr', { method: 'POST' }),
  pollQrLogin: (sessionId: string) =>
    request<QrLoginPoll>(`/login/qr/${encodeURIComponent(sessionId)}`),
  cancelQrLogin: (sessionId: string) =>
    request<{ ok: boolean }>(`/login/qr/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),
  loginWithCookie: (cookie: string) =>
    request<AccountView>('/login/cookie', {
      method: 'POST',
      ...jsonBody({ cookie }),
    }),

  accounts: () => request<AccountView[]>('/accounts'),
  refreshAccount: (accountId: string) =>
    request<AccountView>(`/accounts/${encodeURIComponent(accountId)}/refresh`, {
      method: 'POST',
    }),
  logout: (accountId: string) =>
    request<{ ok: boolean }>(`/accounts/${encodeURIComponent(accountId)}`, {
      method: 'DELETE',
    }),

  listFiles: (accountId: string, parentFid: string, page = 1, size = 100) =>
    request<ListResult>(
      `/files?accountId=${encodeURIComponent(accountId)}&parentFid=${encodeURIComponent(
        parentFid
      )}&page=${page}&size=${size}`
    ),
  mkdir: (accountId: string, parentFid: string, name: string) =>
    request<{ fid: string }>('/files/mkdir', {
      method: 'POST',
      ...jsonBody({ accountId, parentFid, name }),
    }),
  rename: (accountId: string, fid: string, name: string) =>
    request<{ ok: boolean }>('/files/rename', {
      method: 'POST',
      ...jsonBody({ accountId, fid, name }),
    }),
  moveFiles: (accountId: string, fids: string[], parentFid: string) =>
    request<{ ok: boolean }>('/files/move', {
      method: 'POST',
      ...jsonBody({ accountId, fids, parentFid }),
    }),
  deleteFiles: (accountId: string, fids: string[], permanent = false) =>
    request<{ ok: boolean }>('/files/delete', {
      method: 'POST',
      ...jsonBody({ accountId, fids, permanent }),
    }),

  listRecycle: (accountId: string, page = 1, size = 100) =>
    request<RecycleListResult>(
      `/recycle?accountId=${encodeURIComponent(accountId)}&page=${page}&size=${size}`
    ),
  restoreRecycle: (accountId: string, recordIds: string[]) =>
    request<{ ok: boolean }>('/recycle/restore', {
      method: 'POST',
      ...jsonBody({ accountId, recordIds }),
    }),
  deleteRecycle: (accountId: string, recordIds: string[]) =>
    request<{ ok: boolean }>('/recycle/delete', {
      method: 'POST',
      ...jsonBody({ accountId, recordIds }),
    }),
  clearRecycle: (accountId: string) =>
    request<{ removed: number }>('/recycle/clear', {
      method: 'POST',
      ...jsonBody({ accountId, recordIds: [] }),
    }),

  listTransfers: (limit = 300) =>
    request<TransferView[]>(`/transfers?limit=${limit}`),
  completedDownloads: () => request<TransferView[]>('/downloads'),
  downloadFileUrl: (id: string) =>
    `${APP_BASE}/api/downloads/${encodeURIComponent(id)}/file`,
  enqueueDownload: (accountId: string, destDir: string, items: DownloadItem[]) =>
    request<{ ids: string[]; dest: string }>('/transfers/download', {
      method: 'POST',
      ...jsonBody({ accountId, destDir, items }),
    }),
  transferAction: (id: string, action: 'pause' | 'resume' | 'retry' | 'cancel') =>
    request<{ ok: boolean }>(`/transfers/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
    }),
  removeTransfer: (id: string) =>
    request<{ ok: boolean }>(`/transfers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  clearTransfers: () =>
    request<{ ok: boolean }>('/transfers/clear', { method: 'POST' }),

  settings: () => request<Settings>('/settings'),
  updateSettings: (patch: {
    downloadDir?: string;
    concurrency?: number;
    maxSpeedBps?: number;
    theme?: string;
    lanOnly?: boolean;
  }) =>
    request<Settings>('/settings', {
      method: 'PATCH',
      ...jsonBody(patch),
    }),
};

export const eventsUrl = `${APP_BASE}/api/events`;
export const transcodeEventsUrl = `${APP_BASE}/api/transcode/events`;
export const imageEventsUrl = `${APP_BASE}/api/images/events`;
export const speedTest = {
  pingUrl: () => `${APP_BASE}/api/speedtest/ping?ts=${Date.now()}`,
  downloadUrl: (bytes: number) =>
    `${APP_BASE}/api/speedtest/download?bytes=${bytes}&ts=${Date.now()}`,
  uploadUrl: `${APP_BASE}/api/speedtest/upload`,
};
