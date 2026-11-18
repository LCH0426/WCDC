import type { TransferView } from './types';

export function formatBytes(value: number | null | undefined): string {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const scaled = bytes / Math.pow(1024, index);
  const digits = scaled >= 100 || index === 0 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[index]}`;
}

export function formatSpeed(bps: number | null | undefined): string {
  const value = Number(bps ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '—';
  return `${formatBytes(value)}/s`;
}

export function formatDate(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff >= 0 && diff < 60_000) return '刚刚';
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const pad = (input: number) => String(input).padStart(2, '0');
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameYear ? `${day} ${time}` : `${date.getFullYear()}-${day} ${time}`;
}

export function formatExpire(value: number | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')} 到期`;
}

export function percentOf(done: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

export function transferPercent(transfer: TransferView): number {
  return percentOf(transfer.doneBytes, transfer.totalBytes);
}

export function transferStatusLabel(transfer: TransferView): string {
  switch (transfer.status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '下载中';
    case 'paused':
      return '已暂停';
    case 'done':
      return '已完成';
    case 'canceled':
      return '已取消';
    case 'error':
      return '失败';
    default:
      return transfer.status || '未知';
  }
}

export function transferStatusColor(
  transfer: TransferView
): 'default' | 'primary' | 'success' | 'warning' | 'danger' {
  switch (transfer.status) {
    case 'running':
      return 'primary';
    case 'done':
      return 'success';
    case 'paused':
      return 'warning';
    case 'error':
    case 'canceled':
      return 'danger';
    default:
      return 'default';
  }
}

export function fileKind(
  name: string,
  isDir: boolean,
  formatType = ''
): 'folder' | 'video' | 'image' | 'audio' | 'doc' | 'archive' | 'file' {
  if (isDir) return 'folder';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts'].includes(ext)) {
    return 'video';
  }
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) {
    return 'image';
  }
  if (['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'wma'].includes(ext)) {
    return 'audio';
  }
  if (
    ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'epub', 'csv'].includes(
      ext
    )
  ) {
    return 'doc';
  }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2', 'iso'].includes(ext)) {
    return 'archive';
  }
  if (formatType) return 'file';
  return 'file';
}

export function truncateMiddle(value: string, max = 48): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}
