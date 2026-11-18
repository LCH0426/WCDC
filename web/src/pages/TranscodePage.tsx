import { Button } from '@heroui/button';
import { Input } from '@heroui/input';
import { Spinner } from '@heroui/spinner';
import { Switch } from '@heroui/switch';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  MdCancel,
  MdContentCopy,
  MdDeleteOutline,
  MdExpandMore,
  MdFolderOpen,
  MdHistory,
  MdImage,
  MdMemory,
  MdMovieFilter,
  MdPlayArrow,
  MdReplay,
  MdSearch,
  MdSettings,
  MdSpeed,
  MdWarningAmber,
} from 'react-icons/md';
import toast from 'react-hot-toast';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { HistoryPanel } from '@/components/HistoryPanel';
import { ImageConvertPanel } from '@/components/ImageConvertPanel';
import { StorageBrowser } from '@/components/StorageBrowser';
import { VendorLogo } from '@/components/VendorLogo';
import { useApp } from '@/context/app';
import { api, transcodeEventsUrl } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import type {
  CodecImpls,
  CreateJobsRequest,
  GpuInfo,
  HwDevice,
  JobView,
  ScanProgress,
  ScanResult,
  TranscodeEvent,
  TranscodeStats,
  TranscodeStatus,
} from '@/lib/types';

const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264 / AVC',
  hevc: 'H.265 / HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  vvc: 'H.266 / VVC',
  mpeg2video: 'MPEG-2',
  mpeg4: 'MPEG-4 Part 2',
  vc1: 'VC-1',
  prores: 'Apple ProRes',
  h263: 'H.263',
  mjpeg: 'Motion JPEG',
  theora: 'Theora',
};

const CRF_DEFAULTS: Record<string, number> = {
  h264: 23,
  hevc: 26,
  av1: 30,
  vp9: 32,
  vp8: 32,
};

const CRF_MAX: Record<string, number> = {
  h264: 51,
  hevc: 51,
  av1: 63,
  vp9: 63,
  vp8: 63,
};

function supportsCrf(encoder?: string | null): boolean {
  if (!encoder) return false;
  return (
    /^(libx264|libx265|libsvtav1|libaom-av1|libvpx)/.test(encoder) ||
    /_(nvenc|qsv|vaapi|amf)$/.test(encoder)
  );
}

const SOFTWARE_PREFERENCE: Record<string, string[]> = {
  h264: ['libx264'],
  hevc: ['libx265'],
  av1: ['libsvtav1', 'libaom-av1', 'librav1e'],
  vp9: ['libvpx-vp9'],
  vp8: ['libvpx'],
};

const TARGET_CODECS = new Set(['h264', 'hevc', 'av1', 'vp9', 'vp8']);
const SCAN_PAGE_SIZE = 100;

type TranscodeTab = 'scan' | 'settings' | 'jobs' | 'capabilities' | 'convert' | 'history';

// Keep in sync with DIRECT_ENCODER_ACCELS in apps/server/src/transcode/command.rs.
const DIRECT_ENCODER_ACCELS = new Set([
  'nvenc',
  'qsv',
  'vaapi',
  'amf',
  'mf',
  'videotoolbox',
  'rkmpp',
  'v4l2m2m',
]);

const SOURCE_CODECS = [
  { value: '', label: '全部编码' },
  { value: 'h264', label: 'H.264' },
  { value: 'hevc', label: 'H.265 / HEVC' },
  { value: 'av1', label: 'AV1' },
  { value: 'vp9', label: 'VP9' },
  { value: 'vp8', label: 'VP8' },
  { value: 'mpeg2video', label: 'MPEG-2' },
  { value: 'mpeg4', label: 'MPEG-4' },
  { value: 'vc1', label: 'VC-1' },
  { value: 'prores', label: 'ProRes' },
];

const ACCEL_LABELS: Record<string, string> = {
  nvenc: 'NVENC',
  qsv: 'QSV',
  vaapi: 'VAAPI',
  amf: 'AMF',
  mf: 'Media Foundation',
  videotoolbox: 'VideoToolbox',
  rkmpp: 'Rockchip MPP',
  v4l2m2m: 'V4L2 M2M',
};

const VENDOR_LABELS: Record<string, string> = {
  intel: 'Intel',
  amd: 'AMD',
  nvidia: 'NVIDIA',
  apple: 'Apple',
  microsoft: 'Windows',
  generic: '通用',
  arm: 'ARM',
  rockchip: 'Rockchip',
};

const SOURCE_LABEL: Record<string, string> = {
  custom: '自定义路径',
  env: '环境变量',
  path: '系统 PATH',
  common: '常见安装位置',
};

interface EncoderPick {
  name: string;
  hardware: boolean;
  accel?: string | null;
  vendor?: string | null;
  vendorLabel: string;
}

interface Option {
  value: string;
  label: string;
}

function codecLabel(codec: string): string {
  return CODEC_LABELS[codec] ?? codec;
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatEta(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function formatBitrate(bps: number): string {
  if (!bps || bps <= 0) return '—';
  return `${(bps / 1_000_000).toFixed(2)} Mbps`;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已复制');
    return;
  } catch {
    // Clipboard API needs a secure context; fall back for plain HTTP LAN use.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
    toast.success('已复制');
  } catch {
    toast.error('复制失败');
  } finally {
    area.remove();
  }
}

function sortJobs(jobs: JobView[]): JobView[] {
  const seen = new Set<string>();
  const weight = (status: string) => {
    if (status === 'running') return 0;
    if (status === 'queued') return 1;
    return 2;
  };
  return jobs
    .filter((job) => {
      if (seen.has(job.id)) return false;
      seen.add(job.id);
      return true;
    })
    .sort(
      (left, right) =>
        weight(left.status) - weight(right.status) ||
        right.createdAt - left.createdAt
    );
}

function upsertJob(jobs: JobView[], job: JobView): JobView[] {
  const index = jobs.findIndex((item) => item.id === job.id);
  if (index < 0) return sortJobs([job, ...jobs]);
  const next = jobs.slice();
  next[index] = job;
  return sortJobs(next);
}

function accelRank(accel: string, platform: string): number {
  if (platform === 'Windows') {
    return { nvenc: 0, qsv: 1, amf: 2, mf: 3 }[accel] ?? 9;
  }
  if (platform === 'macOS') {
    return accel === 'videotoolbox' ? 0 : 9;
  }
  return { nvenc: 0, qsv: 1, vaapi: 2, rkmpp: 3, v4l2m2m: 4 }[accel] ?? 9;
}

function usableAccelSet(status: TranscodeStatus | null): Set<string> {
  return new Set(
    (status?.devices ?? [])
      .filter(
        (device) =>
          device.available &&
          device.verified !== false &&
          DIRECT_ENCODER_ACCELS.has(device.accel)
      )
      .map((device) => device.accel)
  );
}

function autoEncoderFor(
  status: TranscodeStatus | null,
  codec: string
): EncoderPick | null {
  if (!status) return null;
  const support = status.codecs.find((entry) => entry.codec === codec);
  if (!support) return null;
  const usable = usableAccelSet(status);
  const hardware = support.encode.hardware
    .filter((implementation) => usable.has(implementation.accel))
    .sort((left, right) => {
      const leftVerified =
        status.devices.find((device) => device.accel === left.accel)?.verified === true;
      const rightVerified =
        status.devices.find((device) => device.accel === right.accel)?.verified === true;
      return (
        accelRank(left.accel, status.platform) - accelRank(right.accel, status.platform) ||
        Number(rightVerified) - Number(leftVerified)
      );
    });
  if (hardware.length > 0) {
    const implementation = hardware[0];
    return {
      name: implementation.name,
      hardware: true,
      accel: implementation.accel,
      vendor: implementation.vendor,
      vendorLabel: implementation.vendorLabel,
    };
  }
  for (const name of SOFTWARE_PREFERENCE[codec] ?? []) {
    if (support.encode.software.includes(name)) {
      return { name, hardware: false, vendorLabel: '软件' };
    }
  }
  const first = support.encode.software[0];
  return first
    ? { name: first, hardware: false, vendorLabel: '软件' }
    : null;
}

function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className='block'>
      <span className='text-xs font-medium text-slate-600 dark:text-slate-300'>{label}</span>
      <span className='relative mt-1 block'>
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={clsx(
            'w-full appearance-none rounded-xl border border-slate-200/80 bg-white/70 px-3 py-2 pr-9 text-sm text-slate-800 outline-none transition',
            'focus:border-primary focus:ring-2 focus:ring-primary/20',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100'
          )}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <MdExpandMore
          size={18}
          className='pointer-events-none absolute right-2.5 top-2 text-slate-400'
        />
      </span>
      {hint && (
        <span className='mt-1 block text-[11px] leading-relaxed text-slate-400 dark:text-slate-500'>
          {hint}
        </span>
      )}
    </label>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-2xl bg-white/40 p-3 dark:bg-white/[0.03]'>
      <div className='text-[10px] font-semibold uppercase tracking-wider text-slate-400'>
        {label}
      </div>
      <div className='mt-1 truncate text-sm text-slate-800 dark:text-slate-100' title={value}>
        {value}
      </div>
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className='mb-3 flex items-center gap-2 px-1'>
      <span className='text-primary'>{icon}</span>
      <div className='min-w-0'>
        <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>{title}</div>
        <div className='text-[11px] text-slate-500 dark:text-slate-400'>{subtitle}</div>
      </div>
    </div>
  );
}

function GpuCard({ gpu }: { gpu: GpuInfo }) {
  return (
    <div className='rounded-2xl border border-white/60 bg-white/40 p-4 dark:border-white/[0.06] dark:bg-white/[0.03]'>
      <div className='flex items-center gap-3'>
        <VendorLogo vendor={gpu.vendor} size='md' />
        <div className='min-w-0'>
          <div className='truncate text-sm font-semibold text-slate-900 dark:text-white'>
            {gpu.name}
          </div>
          <div className='text-xs text-slate-500 dark:text-slate-400'>
            {gpu.vendorLabel}
            {gpu.driver ? ` · 驱动 ${gpu.driver}` : ''}
          </div>
        </div>
      </div>
      {(gpu.bus || gpu.renderDevices.length > 0) && (
        <div className='mt-3 flex flex-wrap gap-1.5'>
          {gpu.bus && (
            <span className='rounded-full bg-default-100 px-2 py-0.5 text-[11px] text-default-600 dark:bg-white/[0.06] dark:text-default-300'>
              {gpu.bus}
            </span>
          )}
          {gpu.renderDevices.map((device) => (
            <span
              key={device}
              className='rounded-full bg-default-100 px-2 py-0.5 text-[11px] text-default-600 dark:bg-white/[0.06] dark:text-default-300'
            >
              {device}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function deviceChip(device: HwDevice) {
  if (device.verified === true) {
    return { label: '自检通过', className: 'bg-success/10 text-success' };
  }
  if (device.verified === false) {
    return { label: '自检失败', className: 'bg-danger/10 text-danger' };
  }
  if (device.available) {
    return { label: '可用', className: 'bg-primary/10 text-primary' };
  }
  return { label: '不可用', className: 'bg-default-100 text-default-500' };
}

function DeviceCard({ device }: { device: HwDevice }) {
  const chip = deviceChip(device);
  return (
    <div className='rounded-2xl border border-white/60 bg-white/40 p-4 dark:border-white/[0.06] dark:bg-white/[0.03]'>
      <div className='flex items-center gap-2'>
        <VendorLogo vendor={device.vendor} size='xs' />
        <div className='min-w-0 flex-1'>
          <div className='truncate text-sm font-semibold text-slate-900 dark:text-white'>
            {device.label}
          </div>
          <div className='text-[11px] text-slate-500 dark:text-slate-400'>
            {device.vendorLabel}
          </div>
        </div>
        <span
          className={clsx(
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
            chip.className
          )}
        >
          {chip.label}
        </span>
      </div>
      {(device.device || device.note) && (
        <div className='mt-3 space-y-1 text-[11px] text-slate-500 dark:text-slate-400'>
          {device.device && <div className='truncate'>{device.device}</div>}
          {device.note && <div className='break-words'>{device.note}</div>}
        </div>
      )}
    </div>
  );
}

function CodecCell({
  impls,
  usableAccels,
}: {
  impls: CodecImpls;
  usableAccels: Set<string>;
}) {
  if (impls.software.length === 0 && impls.hardware.length === 0) {
    return <span className='text-xs text-slate-400 dark:text-slate-500'>—</span>;
  }
  return (
    <div className='flex flex-wrap gap-1.5'>
      {impls.hardware.map((impl) => {
        const usable = usableAccels.has(impl.accel);
        return (
          <span
            key={impl.name}
            className={clsx(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
              usable
                ? 'bg-primary/10 text-primary dark:bg-primary/15 dark:text-primary-300'
                : 'bg-default-100 text-default-500 opacity-70 dark:bg-white/[0.06] dark:text-default-400'
            )}
            title={`${impl.name} · ${impl.vendorLabel}${usable ? '' : ' · 当前不可用'}`}
          >
            <VendorLogo vendor={impl.vendor} size='xs' />
            {impl.name}
          </span>
        );
      })}
      {impls.software.map((name) => (
        <span
          key={name}
          className='rounded-full bg-default-100 px-2 py-0.5 text-[11px] text-default-600 dark:bg-white/[0.06] dark:text-default-300'
        >
          {name}
        </span>
      ))}
    </div>
  );
}

function jobStatusChip(status: string) {
  switch (status) {
    case 'running':
      return { label: '转码中', className: 'bg-primary/10 text-primary' };
    case 'queued':
      return { label: '排队中', className: 'bg-secondary/15 text-secondary-700 dark:text-secondary-300' };
    case 'done':
      return { label: '已完成', className: 'bg-success/10 text-success' };
    case 'failed':
      return { label: '失败', className: 'bg-danger/10 text-danger' };
    case 'canceled':
      return { label: '已取消', className: 'bg-default-100 text-default-500' };
    default:
      return { label: status, className: 'bg-default-100 text-default-500' };
  }
}

function JobRow({
  job,
  onCancel,
  onRetry,
}: {
  job: JobView;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const chip = jobStatusChip(job.status);
  const active = job.status === 'running' || job.status === 'queued';
  const done = job.status === 'done';
  const sourceBytes = job.sourceBytes ?? 0;
  const outputBytes = job.outputBytes ?? 0;
  const sizeDelta =
    done && sourceBytes > 0
      ? ((outputBytes - sourceBytes) / sourceBytes) * 100
      : null;

  const dot =
    job.status === 'running'
      ? 'bg-primary animate-pulse'
      : job.status === 'queued'
        ? 'bg-secondary'
        : job.status === 'done'
          ? 'bg-success'
          : job.status === 'failed'
            ? 'bg-danger'
            : 'bg-default-400';

  return (
    <div className='px-4 py-3 [content-visibility:auto] [contain-intrinsic-size:96px]'>
      <div className='flex items-center gap-2'>
        <span className={clsx('h-2 w-2 shrink-0 rounded-full', dot)} />
        <span
          className='min-w-0 flex-1 truncate text-sm font-semibold text-slate-900 dark:text-white'
          title={job.sourcePath}
        >
          {job.sourceName}
        </span>
        <span
          className={clsx(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
            chip.className
          )}
        >
          {chip.label}
        </span>
        {job.hardware && (
          <span className='hidden shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary sm:inline'>
            {ACCEL_LABELS[job.accel ?? ''] ?? job.accel} ·{' '}
            {VENDOR_LABELS[job.vendor ?? ''] ?? job.vendor}
          </span>
        )}
        {active ? (
          <Button
            size='sm'
            variant='light'
            color='danger'
            isIconOnly
            aria-label='取消任务'
            title='取消任务'
            onPress={() => onCancel(job.id)}
          >
            <MdCancel size={17} />
          </Button>
        ) : (
          <Button
            size='sm'
            variant='light'
            isIconOnly
            aria-label='重试任务'
            title='重试任务'
            onPress={() => onRetry(job.id)}
          >
            <MdReplay size={16} />
          </Button>
        )}
      </div>

      <div
        className='mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400'
        title={`${job.sourcePath} → ${job.outputPath}`}
      >
        {codecLabel(job.sourceCodec)} {job.sourceWidth}x{job.sourceHeight} →{' '}
        {codecLabel(job.targetCodec)} {job.resolution} · {job.encoder} ·{' '}
        {job.quality ?? `${job.bitrateKbps} kbps`}
      </div>

      <div className='mt-2 flex items-center gap-2'>
        <div className='h-1.5 flex-1 overflow-hidden rounded-full bg-default-100 dark:bg-white/[0.07]'>
          <div
            className={clsx(
              'h-full rounded-full transition-all duration-500',
              job.status === 'failed'
                ? 'bg-danger'
                : job.status === 'canceled'
                  ? 'bg-default-400'
                  : 'bg-gradient-to-r from-primary-300 to-primary'
            )}
            style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
          />
        </div>
        <span className='w-12 shrink-0 text-right text-[11px] font-medium text-slate-600 dark:text-slate-300'>
          {job.progress.toFixed(1)}%
        </span>
      </div>

      <div className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400'>
        {active && (
          <>
            <span>速度 {job.speed ? `${job.speed.toFixed(2)}x` : '—'}</span>
            <span>FPS {job.fps ? job.fps.toFixed(1) : '—'}</span>
            <span>剩余 {formatEta(job.etaSeconds)}</span>
            <span>
              {formatDuration(job.outTimeMs)} / {formatDuration(job.durationMs)}
            </span>
            <span>
              输出 {formatBytes(outputBytes)}
              {job.estimatedBytes > 0
                ? ` / 约 ${formatBytes(job.estimatedBytes)}`
                : ''}
            </span>
          </>
        )}
        {done && (
          <>
            {sourceBytes > 0 && (
              <span>
                大小 {formatBytes(sourceBytes)} → {formatBytes(outputBytes)}
                {sizeDelta != null && (
                  <span
                    className={clsx(
                      'ml-1 font-medium',
                      sizeDelta <= 0 ? 'text-success' : 'text-warning'
                    )}
                  >
                    {' '}
                    {Math.abs(sizeDelta) < 0.05
                      ? '大小不变'
                      : `${sizeDelta < 0 ? '节省' : '增大'} ${Math.abs(sizeDelta).toFixed(1)}%`}
                  </span>
                )}
              </span>
            )}
            {sourceBytes === 0 && <span>输出 {formatBytes(outputBytes)}</span>}
            <span>时长 {formatDuration(job.durationMs)}</span>
            <span>{job.encoder}</span>
          </>
        )}
        {!active && !done && <span>输出 {formatBytes(outputBytes)}</span>}
      </div>

      {(job.error || job.note) && (
        <div
          className={clsx(
            'mt-1 line-clamp-2 break-words text-[11px]',
            job.error
              ? 'text-danger'
              : 'text-slate-500 dark:text-slate-400'
          )}
          title={job.error ?? job.note ?? ''}
        >
          {job.error ? `错误：${job.error}` : job.note}
        </div>
      )}
    </div>
  );
}

function StatsPanel({ stats }: { stats: TranscodeStats | null }) {
  if (!stats) return null;
  const memoryPercent =
    stats.memoryTotalBytes > 0
      ? (stats.memoryUsedBytes / stats.memoryTotalBytes) * 100
      : 0;
  return (
    <div className='glass-card flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-[11px] text-slate-600 dark:text-slate-300'>
      <span className='inline-flex items-center gap-1.5'>
        <span className='text-slate-400'>CPU</span>
        <span className='font-medium'>{stats.cpuUsagePercent.toFixed(1)}%</span>
        <span className='h-1.5 w-16 overflow-hidden rounded-full bg-default-100 dark:bg-white/[0.07]'>
          <span
            className='block h-full rounded-full bg-primary'
            style={{ width: `${Math.min(100, stats.cpuUsagePercent)}%` }}
          />
        </span>
      </span>
      <span className='text-slate-400'>
        内存 {formatBytes(stats.memoryUsedBytes)} /{' '}
        {formatBytes(stats.memoryTotalBytes)}（{memoryPercent.toFixed(0)}%）
      </span>
      {stats.gpus.length === 0 ? (
        <span className='text-slate-400'>GPU 利用率不可用</span>
      ) : (
        stats.gpus.map((gpu) => (
          <span
            key={`${gpu.index}-${gpu.name}`}
            className='inline-flex items-center gap-1.5 rounded-full bg-white/50 px-2 py-1 dark:bg-white/[0.04]'
            title={`${gpu.name} · ${gpu.source}`}
          >
            <VendorLogo vendor={gpu.vendor} size='xs' />
            <span className='max-w-[150px] truncate font-medium text-slate-700 dark:text-slate-200'>
              {gpu.name}
            </span>
            <span className='font-semibold text-primary'>
              {gpu.utilization == null ? '—' : `${gpu.utilization.toFixed(0)}%`}
            </span>
            {gpu.encoder != null && (
              <span className='text-slate-400'>编码 {gpu.encoder.toFixed(0)}%</span>
            )}
            {gpu.decoder != null && (
              <span className='text-slate-400'>解码 {gpu.decoder.toFixed(0)}%</span>
            )}
            {gpu.memoryUsedBytes != null && gpu.memoryTotalBytes != null && (
              <span className='text-slate-400'>
                {formatBytes(gpu.memoryUsedBytes)}/{formatBytes(gpu.memoryTotalBytes)}
              </span>
            )}
            {gpu.temperatureC != null && (
              <span className='text-slate-400'>{gpu.temperatureC.toFixed(0)}°C</span>
            )}
          </span>
        ))
      )}
    </div>
  );
}

export default function TranscodePage() {
  const { settings } = useApp();
  const [status, setStatus] = useState<TranscodeStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savingPath, setSavingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TranscodeTab>(() => {
    const stored = window.localStorage.getItem('wcdc.transcode.tab');
    return stored === 'settings' ||
      stored === 'jobs' ||
      stored === 'capabilities' ||
      stored === 'convert' ||
      stored === 'history'
      ? stored
      : 'scan';
  });

  useEffect(() => {
    window.localStorage.setItem('wcdc.transcode.tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'capabilities') setDetailsOpen(true);
  }, [activeTab]);

  const [scanDir, setScanDir] = useState(() => {
    try {
      const stored = window.localStorage.getItem('wcdc.transcode.scanDir');
      if (stored && stored.trim()) return stored;
    } catch {
      // localStorage may be unavailable in private mode.
    }
    return settings?.downloadDir ?? '';
  });
  useEffect(() => {
    try {
      const value = scanDir.trim();
      if (value) {
        window.localStorage.setItem('wcdc.transcode.scanDir', value);
      } else {
        window.localStorage.removeItem('wcdc.transcode.scanDir');
      }
    } catch {
      // Ignore storage quota/privacy errors.
    }
  }, [scanDir]);

  const [recursive, setRecursive] = useState(true);
  const [sourceCodec, setSourceCodec] = useState('');
  const [minSizeMb, setMinSizeMb] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanPage, setScanPage] = useState(0);
  const [browseTarget, setBrowseTarget] = useState<'scan' | 'output' | null>(null);

  const [targetCodec, setTargetCodec] = useState('hevc');
  const [encoderChoice, setEncoderChoice] = useState('auto');
  const [container, setContainer] = useState('mp4');
  const [resolution, setResolution] = useState('source');
  const [customWidth, setCustomWidth] = useState('');
  const [customHeight, setCustomHeight] = useState('');
  const [bitrateMode, setBitrateMode] = useState('source');
  const [bitrateMbps, setBitrateMbps] = useState('4');
  const [crf, setCrf] = useState(23);
  const [audio, setAudio] = useState('copy');
  const [concurrency, setConcurrency] = useState(1);
  const [cpuThreads, setCpuThreads] = useState('0');
  const [deleteOriginal, setDeleteOriginal] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [outputMode, setOutputMode] = useState<'same' | 'custom'>('same');
  const [outputDir, setOutputDir] = useState('');
  const [hdrToSdr, setHdrToSdr] = useState(true);
  const [starting, setStarting] = useState(false);

  const [jobs, setJobs] = useState<JobView[]>([]);
  const [stats, setStats] = useState<TranscodeStats | null>(null);
  const [clearing, setClearing] = useState(false);

  const loadJobs = useCallback(async () => {
    try {
      setJobs(sortJobs(await api.transcodeJobs()));
    } catch {
      // The page still works with SSE updates; polling retries later.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const result = await api.transcodeCached();
        if (cancelled) return;
        if (result.status) {
          setStatus(result.status);
          setPathInput(result.status.path ?? '');
          return;
        }
        // First ever visit: detect once and persist the result in SQLite.
        setAutoDetecting(true);
        try {
          const data = await api.transcodeStatus(true);
          if (cancelled) return;
          setStatus(data);
          setPathInput(data.path ?? '');
        } catch (error) {
          if (!cancelled) {
            toast.error(
              error instanceof Error ? error.message : '首次自动检测失败'
            );
          }
        } finally {
          if (!cancelled) setAutoDetecting(false);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof Error ? error.message : '读取检测结果失败'
          );
        }
      } finally {
        if (!cancelled) setStatusLoaded(true);
      }
    };
    void init();
    void loadJobs();
    return () => {
      cancelled = true;
    };
  }, [loadJobs]);

  useEffect(() => {
    const source = new EventSource(transcodeEventsUrl, { withCredentials: true });
    source.onmessage = (message) => {
      let event: TranscodeEvent;
      try {
        event = JSON.parse(message.data) as TranscodeEvent;
      } catch {
        return;
      }
      if (event.type === 'jobUpdated') {
        setJobs((current) => upsertJob(current, event.job));
      } else if (event.type === 'jobsCleared') {
        void loadJobs();
      }
    };
    return () => source.close();
  }, [loadJobs]);

  useEffect(() => {
    const timer = window.setInterval(() => void loadJobs(), 5000);
    return () => window.clearInterval(timer);
  }, [loadJobs]);

  const activeJobs = jobs.some(
    (job) => job.status === 'running' || job.status === 'queued'
  );

  useEffect(() => {
    if (!activeJobs) {
      setStats(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      void api
        .transcodeStats()
        .then((value) => {
          if (!cancelled) setStats(value);
        })
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJobs]);

  const detect = async () => {
    setDetecting(true);
    try {
      const data = await api.transcodeStatus(true);
      setStatus(data);
      setPathInput(data.path ?? '');
      if (data.found) {
        toast.success(`ffmpeg ${data.version ?? ''} 已就绪`);
      } else {
        toast.error(data.error || '未找到可用的 ffmpeg');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '检测 ffmpeg 失败');
    } finally {
      setDetecting(false);
    }
  };

  const runSelfTest = async () => {
    if (!status?.found) return;
    setTesting(true);
    try {
      const data = await api.transcodeSelfTest();
      setStatus(data);
      const failed = data.devices.filter((device) => device.verified === false).length;
      if (failed > 0) toast.error(`${failed} 项硬件自检未通过`);
      else toast.success('硬件自检完成');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '硬件自检失败');
    } finally {
      setTesting(false);
    }
  };

  const savePath = async () => {
    setSavingPath(true);
    try {
      const data = await api.transcodeSetPath(pathInput.trim() || null);
      setStatus(data);
      setPathInput(data.path ?? '');
      if (data.found) toast.success('ffmpeg 可用');
      else toast.error(data.error || '已保存，但没有检测到可用的 ffmpeg');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存 ffmpeg 路径失败');
    } finally {
      setSavingPath(false);
    }
  };

  const clearPath = async () => {
    setSavingPath(true);
    try {
      const data = await api.transcodeSetPath(null);
      setStatus(data);
      setPathInput(data.path ?? '');
      toast.success('已恢复自动检测');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复自动检测失败');
    } finally {
      setSavingPath(false);
    }
  };

  const codecOptions = useMemo<Option[]>(() => {
    if (!status) return [];
    return status.codecs
      .filter(
        (codec) =>
          TARGET_CODECS.has(codec.codec) &&
          (codec.encode.software.length > 0 || codec.encode.hardware.length > 0)
      )
      .map((codec) => ({ value: codec.codec, label: codecLabel(codec.codec) }));
  }, [status]);

  useEffect(() => {
    if (!status || codecOptions.length === 0) return;
    if (!codecOptions.some((option) => option.value === targetCodec)) {
      setTargetCodec(codecOptions[0].value);
      setEncoderChoice('auto');
    }
  }, [status, codecOptions, targetCodec]);

  useEffect(() => {
    if (targetCodec === 'vp9' || targetCodec === 'vp8') {
      setContainer('mkv');
    }
  }, [targetCodec]);

  const codecSupport = status?.codecs.find((codec) => codec.codec === targetCodec);
  const usableAccels = useMemo(() => usableAccelSet(status), [status]);

  const encoderOptions = useMemo<Option[]>(() => {
    const options: Option[] = [{ value: 'auto', label: '自动（优先硬件）' }];
    if (codecSupport) {
      codecSupport.encode.hardware
        .filter((implementation) => usableAccels.has(implementation.accel))
        .forEach((implementation) => {
          const verified =
            status?.devices.find((device) => device.accel === implementation.accel)
              ?.verified === true;
          options.push({
            value: implementation.name,
            label: `${implementation.name} · ${implementation.vendorLabel}${verified ? ' · 已验证' : ''}`,
          });
        });
      codecSupport.encode.software.forEach((name) => {
        options.push({ value: name, label: `${name}（软件）` });
      });
    }
    return options;
  }, [codecSupport, status, usableAccels]);

  useEffect(() => {
    if (!encoderOptions.some((option) => option.value === encoderChoice)) {
      setEncoderChoice('auto');
    }
  }, [encoderOptions, encoderChoice]);

  const autoEncoder = useMemo(
    () => autoEncoderFor(status, targetCodec),
    [status, targetCodec]
  );

  const manualEncoder = useMemo(() => {
    if (encoderChoice === 'auto') return null;
    return (
      codecSupport?.encode.hardware.find(
        (implementation) => implementation.name === encoderChoice
      ) ?? null
    );
  }, [codecSupport, encoderChoice]);

  const encoderGpu = useMemo(() => {
    const vendor =
      encoderChoice === 'auto' ? autoEncoder?.vendor : manualEncoder?.vendor;
    if (!vendor) return null;
    return status?.gpus.find((gpu) => gpu.vendor === vendor)?.name ?? null;
  }, [autoEncoder, encoderChoice, manualEncoder, status]);

  const recommendedCrf = CRF_DEFAULTS[targetCodec] ?? 23;
  const maxCrf = CRF_MAX[targetCodec] ?? 51;
  useEffect(() => {
    setCrf(recommendedCrf);
  }, [recommendedCrf]);

  const activeEncoderName =
    encoderChoice === 'auto' ? autoEncoder?.name : encoderChoice;
  const crfAvailable = supportsCrf(activeEncoderName);

  const encoderHint =
    encoderChoice === 'auto'
      ? autoEncoder
        ? `自动将使用 ${autoEncoder.name}（${autoEncoder.vendorLabel}${
            encoderGpu ? ` · ${encoderGpu}` : ''
          }）`
        : undefined
      : manualEncoder
        ? `硬件编码 · ${manualEncoder.vendorLabel}${
            encoderGpu ? ` · ${encoderGpu}` : ''
          }`
        : '软件编码（使用 CPU）';

  useEffect(() => {
    if (!scanResult) {
      setScanPage(0);
      return;
    }
    const pages = Math.max(
      1,
      Math.ceil(scanResult.files.length / SCAN_PAGE_SIZE)
    );
    setScanPage((page) => Math.min(page, pages - 1));
  }, [scanResult]);

  const scanPageCount = scanResult
    ? Math.max(1, Math.ceil(scanResult.files.length / SCAN_PAGE_SIZE))
    : 1;

  const visibleScanFiles = useMemo(() => {
    if (!scanResult) return [];
    const start = scanPage * SCAN_PAGE_SIZE;
    return scanResult.files.slice(start, start + SCAN_PAGE_SIZE);
  }, [scanResult, scanPage]);

  const selectedFiles = useMemo(
    () => scanResult?.files.filter((file) => selected.has(file.path)) ?? [],
    [scanResult, selected]
  );

  const allSelected =
    !!scanResult &&
    scanResult.files.length > 0 &&
    selected.size === scanResult.files.length;

  const selectedHdr = selectedFiles.some((file) => file.isHdr);
  const averageBitrate =
    selectedFiles.length > 0
      ? selectedFiles.reduce((sum, file) => sum + file.videoBitrateBps, 0) /
        selectedFiles.length
      : 0;

  const estimatedTotal = useMemo(() => {
    const customBps = Math.max(0, Number(bitrateMbps) || 0) * 1_000_000;
    const audioBps = audio === 'none' ? 0 : 192_000;
    return selectedFiles.reduce((sum, file) => {
      const videoBps = bitrateMode === 'custom' ? customBps : file.videoBitrateBps;
      return sum + ((videoBps + audioBps) / 8) * (file.durationMs / 1000);
    }, 0);
  }, [audio, bitrateMbps, bitrateMode, selectedFiles]);

  useEffect(() => {
    if (!scanning) return;
    let cancelled = false;
    const tick = () => {
      void api
        .transcodeScanProgress()
        .then((value) => {
          if (!cancelled) setScanProgress(value);
        })
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 400);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [scanning]);

  const scan = async () => {
    if (!status?.found) {
      toast.error('请先点击“检测 ffmpeg”');
      return;
    }
    if (!scanDir.trim()) {
      toast.error('请选择要扫描的文件夹');
      return;
    }
    setScanning(true);
    setScanProgress(null);
    try {
      const result = await api.transcodeScan({
        directory: scanDir.trim(),
        recursive,
        sourceCodec: sourceCodec || null,
        minSizeBytes:
          Number(minSizeMb) > 0
            ? Math.round(Number(minSizeMb) * 1024 * 1024)
            : null,
      });
      setScanResult(result);
      setSelected(new Set(result.files.map((file) => file.path)));
      setScanPage(0);
      if (result.errors.length > 0) {
        toast.error(`扫描完成，但有 ${result.errors.length} 个文件读取失败`);
      } else {
        toast.success(`扫描完成：找到 ${result.matched} 个视频`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '扫描失败');
    } finally {
      setScanning(false);
    }
  };

  const toggleSelected = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(
      allSelected
        ? new Set()
        : new Set((scanResult?.files ?? []).map((file) => file.path))
    );
  };

  const start = async () => {
    if (!status?.found) {
      toast.error('请先检测 ffmpeg');
      return;
    }
    if (selectedFiles.length === 0) {
      toast.error('请先选择要转码的视频');
      return;
    }
    if (
      resolution === 'custom' &&
      !customWidth.trim() &&
      !customHeight.trim()
    ) {
      toast.error('自定义分辨率需要填写宽或高');
      return;
    }
    if (bitrateMode === 'custom' && !(Number(bitrateMbps) > 0)) {
      toast.error('请填写有效的目标码率');
      return;
    }
    if (bitrateMode === 'crf') {
      if (!crfAvailable) {
        toast.error('当前编码器不支持 CRF，请改用码率模式');
        return;
      }
      if (!Number.isFinite(crf) || crf < 0 || crf > maxCrf) {
        toast.error(`CRF 应在 0–${maxCrf} 之间`);
        return;
      }
    }
    if (outputMode === 'custom' && !outputDir.trim()) {
      toast.error('请选择输出文件夹');
      return;
    }

    const payload: CreateJobsRequest = {
      files: selectedFiles.map((file) => file.path),
      targetCodec,
      container,
      encoder: encoderChoice,
      resolution,
      width:
        resolution === 'custom' && customWidth.trim()
          ? Number(customWidth)
          : undefined,
      height:
        resolution === 'custom' && customHeight.trim()
          ? Number(customHeight)
          : undefined,
      bitrateMode,
      bitrateKbps:
        bitrateMode === 'custom'
          ? Math.round((Number(bitrateMbps) || 0) * 1000)
          : undefined,
      crf: bitrateMode === 'crf' ? crf : undefined,
      audio,
      concurrency,
      cpuThreads: Number(cpuThreads) > 0 ? Number(cpuThreads) : undefined,
      deleteOriginal,
      outputDir: outputMode === 'custom' ? outputDir.trim() : null,
      hdrToSdr,
    };

    setStarting(true);
    try {
      const created = await api.transcodeCreateJobs(payload);
      setJobs((current) => sortJobs([...created, ...current]));
      setSelected(new Set());
      setActiveTab('jobs');
      toast.success(`已加入 ${created.length} 个转码任务`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建转码任务失败');
    } finally {
      setStarting(false);
    }
  };

  const cancelJob = async (id: string) => {
    try {
      await api.transcodeCancelJob(id);
      toast.success('已请求取消');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消失败');
    }
  };

  const retryJob = async (id: string) => {
    try {
      const created = await api.transcodeRetryJob(id);
      setJobs((current) => sortJobs([...created, ...current]));
      toast.success('已重新加入队列');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重试失败');
    }
  };

  const clearFinished = async () => {
    setClearing(true);
    try {
      const result = await api.transcodeClearJobs();
      setJobs((current) =>
        current.filter(
          (job) => job.status === 'running' || job.status === 'queued'
        )
      );
      toast.success(`已清理 ${result.removed} 条记录`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '清理失败');
    } finally {
      setClearing(false);
    }
  };

  const runningCount = jobs.filter((job) => job.status === 'running').length;
  const queuedCount = jobs.filter((job) => job.status === 'queued').length;
  const doneCount = jobs.filter((job) => job.status === 'done').length;
  const failedCount = jobs.filter((job) => job.status === 'failed').length;
  const canceledCount = jobs.filter((job) => job.status === 'canceled').length;
  const allFinished = jobs.length > 0 && !activeJobs;
  const doneWithSizes = jobs.filter(
    (job) => job.status === 'done' && (job.sourceBytes ?? 0) > 0
  );
  const totalSourceBytes = doneWithSizes.reduce(
    (sum, job) => sum + (job.sourceBytes ?? 0),
    0
  );
  const totalOutputBytes = doneWithSizes.reduce(
    (sum, job) => sum + (job.outputBytes ?? 0),
    0
  );
  const totalSizeDelta =
    totalSourceBytes > 0
      ? ((totalOutputBytes - totalSourceBytes) / totalSourceBytes) * 100
      : null;

  const tabs: {
    id: TranscodeTab;
    label: string;
    icon: ReactNode;
    badge?: number;
  }[] = [
    {
      id: 'scan',
      label: '扫描文件',
      icon: <MdFolderOpen size={17} />,
      badge: selectedFiles.length,
    },
    {
      id: 'settings',
      label: '输出设置',
      icon: <MdSettings size={17} />,
    },
    {
      id: 'jobs',
      label: '转码任务',
      icon: <MdMovieFilter size={17} />,
      badge: runningCount + queuedCount,
    },
    {
      id: 'convert',
      label: '格式转换',
      icon: <MdImage size={17} />,
    },
    {
      id: 'history',
      label: '归档日志',
      icon: <MdHistory size={17} />,
    },
    {
      id: 'capabilities',
      label: '能力检测',
      icon: <MdSpeed size={17} />,
    },
  ];

  const pathEditor = status ? (
    <div className='glass-card p-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
            ffmpeg 路径
          </div>
          <p className='mt-0.5 text-xs text-slate-500 dark:text-slate-400'>
            留空会自动在 PATH 与常见安装位置中查找；也可以指定任意 ffmpeg 可执行文件。
          </p>
        </div>
        {status.path && (
          <span className='rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary'>
            {SOURCE_LABEL[status.source] ?? status.source}
          </span>
        )}
      </div>
      <div className='mt-3 flex flex-col gap-2 md:flex-row md:items-center'>
        <Input
          aria-label='ffmpeg 路径'
          size='sm'
          value={pathInput}
          onValueChange={setPathInput}
          placeholder={'C:\\ffmpeg\\bin\\ffmpeg.exe 或 /usr/bin/ffmpeg'}
          classNames={{ inputWrapper: 'bg-white/60 dark:bg-white/[0.04]' }}
        />
        <div className='flex shrink-0 gap-2'>
          <Button
            size='sm'
            color='primary'
            variant='flat'
            isLoading={savingPath}
            onPress={() => void savePath()}
            startContent={<MdSearch size={16} />}
          >
            检测并保存
          </Button>
          {status.source === 'custom' && (
            <Button size='sm' variant='flat' onPress={() => void clearPath()}>
              恢复自动
            </Button>
          )}
        </div>
      </div>

      {status.candidates.some((candidate) => candidate.exists) && (
        <details className='mt-3'>
          <summary className='cursor-pointer text-xs text-slate-500 dark:text-slate-400'>
            已检查的安装位置（{status.candidates.filter((candidate) => candidate.exists).length}）
          </summary>
          <div className='mt-2 flex flex-wrap gap-1.5'>
            {status.candidates
              .filter((candidate) => candidate.exists)
              .map((candidate) => (
                <button
                  key={candidate.path}
                  type='button'
                  title={candidate.path}
                  onClick={() => setPathInput(candidate.path)}
                  className='max-w-full truncate rounded-full bg-default-100 px-2 py-1 text-[11px] text-default-600 transition hover:bg-primary/10 hover:text-primary dark:bg-white/[0.06] dark:text-default-300'
                >
                  {candidate.path}
                </button>
              ))}
          </div>
        </details>
      )}
    </div>
  ) : null;

  return (
    <div className='animate-float-in space-y-4'>
      <div className='glass-card p-4'>
        <div className='flex flex-wrap items-start gap-4'>
          <div className='flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary'>
            <MdMovieFilter size={26} />
          </div>
          <div className='min-w-0 flex-1'>
            <div className='flex flex-wrap items-center gap-2'>
              <h2 className='text-lg font-semibold text-slate-900 dark:text-white'>
                视频转码
              </h2>
              {status && (
                <span
                  className={clsx(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    status.found
                      ? 'bg-success/10 text-success'
                      : 'bg-warning/10 text-warning'
                  )}
                >
                  {status.found ? `ffmpeg ${status.version ?? ''}` : '未找到 ffmpeg'}
                </span>
              )}
              {statusLoaded && !status && (
                <span className='rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning'>
                  尚未检测
                </span>
              )}
            </div>
            <p className='mt-1 max-w-3xl text-xs leading-relaxed text-slate-500 dark:text-slate-400'>
              首次打开会自动检测一次并保存到数据库；之后只有点击“检测 ffmpeg”才会重新探测。
            </p>
            {status && (
              <p className='mt-1 text-[11px] text-slate-400 dark:text-slate-500'>
                上次检测 {new Date(status.checkedAt).toLocaleString()}
              </p>
            )}
          </div>
          <div className='flex flex-wrap gap-2'>
            <Button
              size='sm'
              color={status?.found ? 'default' : 'primary'}
              variant='flat'
              isLoading={detecting || autoDetecting}
              onPress={() => void detect()}
              startContent={<MdSearch size={16} />}
            >
              检测 ffmpeg
            </Button>
          </div>
        </div>
      </div>

      {statusLoaded && (
        <div className='sticky top-0 z-20 rounded-2xl border border-white/50 bg-content1/85 p-1.5 shadow-lg backdrop-blur-xl dark:border-white/[0.06]'>
          <div className='flex gap-1 overflow-x-auto'>
            {(status?.found
              ? tabs
              : tabs.filter(
                  (tab) => tab.id === 'convert' || tab.id === 'history'
                )
            ).map((tab) => (
              <button
                key={tab.id}
                type='button'
                onClick={() => {
                  setActiveTab(tab.id);
                  if (tab.id === 'capabilities') setDetailsOpen(true);
                }}
                className={clsx(
                  'flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition',
                  activeTab === tab.id
                    ? 'bg-primary/10 text-primary shadow-sm dark:bg-primary/20 dark:text-primary-300'
                    : 'text-slate-500 hover:bg-default-100 dark:text-slate-400 dark:hover:bg-white/[0.05]'
                )}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.badge ? (
                  <span
                    className={clsx(
                      'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                      activeTab === tab.id
                        ? 'bg-white/25 text-white'
                        : 'bg-primary/10 text-primary'
                    )}
                  >
                    {tab.badge}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      )}

      {!statusLoaded && (
        <div className='glass-card flex items-center justify-center gap-3 p-8 text-sm text-slate-500'>
          <Spinner size='sm' />
          {autoDetecting ? '首次自动检测 ffmpeg…' : '正在读取上次检测结果…'}
        </div>
      )}

      {statusLoaded && activeTab !== 'convert' && activeTab !== 'history' && !status && (
        <div className='glass-card p-5'>
          <div className='flex items-start gap-3'>
            <MdWarningAmber className='mt-0.5 shrink-0 text-warning' size={24} />
            <div className='min-w-0'>
              <div className='font-semibold text-slate-900 dark:text-white'>
                尚未完成首次检测
              </div>
              <p className='mt-1 text-sm leading-relaxed text-slate-500 dark:text-slate-400'>
                首次自动检测没有完成。请点击上方“检测 ffmpeg”重试；检测结果会保存到数据库，之后不会自动运行。
              </p>
            </div>
          </div>
        </div>
      )}

      {statusLoaded && activeTab !== 'convert' && activeTab !== 'history' && status && !status.found && (
        <>
          <div className='glass-card p-4'>
            <div className='flex items-start gap-3'>
              <MdWarningAmber className='mt-0.5 shrink-0 text-warning' size={24} />
              <div className='min-w-0'>
                <div className='font-semibold text-slate-900 dark:text-white'>
                  未检测到可用的 ffmpeg
                </div>
                <p className='mt-1 text-sm leading-relaxed text-slate-500 dark:text-slate-400'>
                  请先在服务器上安装 ffmpeg，或指定一个已有的 ffmpeg 可执行文件。安装完成后点击“检测 ffmpeg”重新读取。
                </p>
                {status.error && (
                  <p className='mt-2 break-words rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger'>
                    {status.error}
                  </p>
                )}
              </div>
            </div>

            <div className='mt-4 grid gap-3 md:grid-cols-2'>
              {status.install.map((hint) => (
                <div
                  key={`${hint.label}-${hint.command}`}
                  className='rounded-2xl border border-white/60 bg-white/40 p-3 dark:border-white/[0.06] dark:bg-white/[0.03]'
                >
                  <div className='flex items-center justify-between gap-2'>
                    <span className='text-xs font-semibold text-slate-700 dark:text-slate-200'>
                      {hint.label}
                    </span>
                    {hint.command && (
                      <button
                        type='button'
                        aria-label={`复制 ${hint.label}`}
                        className='rounded p-1 text-slate-400 transition hover:text-primary'
                        onClick={() => void copyText(hint.command)}
                      >
                        <MdContentCopy size={14} />
                      </button>
                    )}
                  </div>
                  {hint.command && (
                    <code className='mt-2 block overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-default-100/80 p-2 text-[11px] text-slate-700 dark:bg-white/[0.06] dark:text-slate-200'>
                      {hint.command}
                    </code>
                  )}
                  {hint.note && (
                    <p className='mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400'>
                      {hint.note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
          {pathEditor}
        </>
      )}

      {statusLoaded && activeTab === 'convert' && <ImageConvertPanel />}
      {statusLoaded && activeTab === 'history' && <HistoryPanel />}

      {statusLoaded && status?.found && (
        <>
          <div
            className={clsx(
              'space-y-4',
              activeTab !== 'scan' && activeTab !== 'settings' && 'hidden'
            )}
          >
            <div className={clsx('space-y-4', activeTab !== 'scan' && 'hidden')}>
              <div className='glass-card p-4'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <div>
                    <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
                      扫描视频
                    </div>
                    <div className='text-[11px] text-slate-500 dark:text-slate-400'>
                      先扫描目录，再按源编码筛选；文件信息来自 ffprobe。
                    </div>
                  </div>
                  <div className='flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400'>
                    <span>递归</span>
                    <Switch size='sm' isSelected={recursive} onValueChange={setRecursive} />
                  </div>
                </div>

                <div className='mt-3 flex flex-col gap-2 md:flex-row'>
                  <Input
                    aria-label='扫描文件夹'
                    size='sm'
                    value={scanDir}
                    onValueChange={setScanDir}
                    placeholder='服务器上的绝对路径，例如 D:\\Media 或 /mnt/media'
                    classNames={{ inputWrapper: 'bg-white/60 dark:bg-white/[0.04]' }}
                  />
                  <div className='flex shrink-0 gap-2'>
                    <Button
                      size='sm'
                      variant='flat'
                      onPress={() => setBrowseTarget('scan')}
                      startContent={<MdFolderOpen size={16} />}
                    >
                      浏览
                    </Button>
                    <Button
                      size='sm'
                      color='primary'
                      variant='flat'
                      isLoading={scanning}
                      onPress={() => void scan()}
                      startContent={<MdSearch size={16} />}
                    >
                      扫描
                    </Button>
                  </div>
                </div>

                <div className='mt-3 grid gap-3 sm:grid-cols-3'>
                  <SelectField
                    label='源编码筛选'
                    value={sourceCodec}
                    onChange={setSourceCodec}
                    options={SOURCE_CODECS}
                    hint='只显示该编码的视频；选“全部编码”则不筛选'
                  />
                  <label className='block'>
                    <span className='text-xs font-medium text-slate-600 dark:text-slate-300'>
                      最小文件大小（MB）
                    </span>
                    <span className='mt-1 block'>
                      <input
                        type='number'
                        min={0}
                        value={minSizeMb}
                        onChange={(event) => setMinSizeMb(event.target.value)}
                        placeholder='留空 = 不限制'
                        className='w-full rounded-xl border border-slate-200/80 bg-white/70 px-3 py-2 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100'
                      />
                    </span>
                    <span className='mt-1 block text-[11px] leading-relaxed text-slate-400 dark:text-slate-500'>
                      只扫描大于该大小的视频；留空不限制
                    </span>
                  </label>
                  <div className='flex items-end pb-1 text-[11px] text-slate-400 dark:text-slate-500'>
                    {scanResult
                      ? `扫描 ${scanResult.scanned} 个视频文件${
                          scanResult.skippedBySize > 0
                            ? `（大小筛选排除 ${scanResult.skippedBySize} 个）`
                            : ''
                        }，匹配 ${scanResult.matched} 个，用时 ${scanResult.tookMs} ms`
                      : '扫描结果会显示在下方'}
                  </div>
                </div>

                {scanning && (
                  <div className='mt-3 rounded-xl bg-primary/[0.04] px-3 py-2 dark:bg-primary/[0.08]'>
                    <div className='flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-300'>
                      <span className='font-medium text-primary'>正在分析视频信息…</span>
                      <span>
                        {scanProgress
                          ? `${scanProgress.processed} / ${scanProgress.total || '…'}`
                          : '准备中'}
                        {scanProgress && scanProgress.cacheHits > 0
                          ? ` · 缓存命中 ${scanProgress.cacheHits}`
                          : ''}
                      </span>
                    </div>
                    <div className='mt-2 h-1.5 overflow-hidden rounded-full bg-primary/10'>
                      <div
                        className='h-full rounded-full bg-gradient-to-r from-primary-300 to-primary transition-all duration-300'
                        style={{
                          width: `${
                            scanProgress && scanProgress.total > 0
                              ? Math.min(
                                  100,
                                  (scanProgress.processed / scanProgress.total) * 100
                                )
                              : 5
                          }%`,
                        }}
                      />
                    </div>
                    <div className='mt-1.5 text-[10px] text-slate-400 dark:text-slate-500'>
                      未变化的文件会直接复用上次 ffprobe 结果，跳过重复分析。
                    </div>
                  </div>
                )}

                {scanResult && scanResult.errors.length > 0 && (
                  <details className='mt-3'>
                    <summary className='cursor-pointer text-[11px] text-danger'>
                      {scanResult.errors.length} 个文件读取失败
                    </summary>
                    <div className='mt-2 max-h-32 overflow-auto rounded-xl bg-danger/5 p-2 text-[10px] text-danger'>
                      {scanResult.errors.map((error) => (
                        <div key={error} className='break-all'>
                          {error}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>

              {scanResult && (
                <div className='glass-card overflow-hidden'>
                  <div className='flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/60 px-4 py-3 dark:border-white/[0.06]'>
                    <div className='flex items-center gap-2'>
                      <span className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
                        扫描结果
                      </span>
                      <span className='rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary'>
                        已选 {selected.size} / {scanResult.files.length}
                      </span>
                    </div>
                    <div className='flex items-center gap-2'>
                      <Button size='sm' variant='light' onPress={toggleAll}>
                        {allSelected ? '清空选择' : '全选'}
                      </Button>
                      <Button
                        size='sm'
                        color='primary'
                        variant='flat'
                        isDisabled={selected.size === 0}
                        onPress={() => setActiveTab('settings')}
                      >
                        下一步：输出设置
                      </Button>
                    </div>
                  </div>
                  <div className='max-h-[460px] overflow-auto'>
                    <table className='w-full min-w-[720px] border-collapse text-left text-sm'>
                      <thead className='sticky top-0 z-10 bg-content1/95 backdrop-blur'>
                        <tr className='border-b border-slate-200/60 text-[10px] uppercase tracking-wider text-slate-400 dark:border-white/[0.06]'>
                          <th className='w-10 px-3 py-2'>
                            <input
                              type='checkbox'
                              aria-label='全选'
                              checked={allSelected}
                              onChange={toggleAll}
                              className='h-4 w-4 accent-pink-500'
                            />
                          </th>
                          <th className='px-2 py-2 font-semibold'>文件</th>
                          <th className='px-2 py-2 font-semibold'>编码 / 分辨率</th>
                          <th className='px-2 py-2 font-semibold'>码率</th>
                          <th className='px-2 py-2 font-semibold'>时长 / 大小</th>
                          <th className='px-2 py-2 font-semibold'>标记</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleScanFiles.map((file) => {
                          const checked = selected.has(file.path);
                          return (
                            <tr
                              key={file.path}
                              onClick={() => toggleSelected(file.path)}
                              className={clsx(
                                'cursor-pointer border-b border-slate-200/40 align-top transition last:border-0 dark:border-white/[0.04]',
                                checked
                                  ? 'bg-primary/[0.04] dark:bg-primary/[0.06]'
                                  : 'hover:bg-default-50/60 dark:hover:bg-white/[0.03]'
                              )}
                            >
                              <td className='px-3 py-2' onClick={(event) => event.stopPropagation()}>
                                <input
                                  type='checkbox'
                                  checked={checked}
                                  onChange={() => toggleSelected(file.path)}
                                  aria-label={file.name}
                                  className='h-4 w-4 accent-pink-500'
                                />
                              </td>
                              <td className='max-w-[230px] px-2 py-2'>
                                <div className='truncate font-medium text-slate-800 dark:text-slate-100' title={file.path}>
                                  {file.name}
                                </div>
                                <div className='truncate text-[10px] text-slate-400' title={file.path}>
                                  {file.path}
                                </div>
                              </td>
                              <td className='whitespace-nowrap px-2 py-2'>
                                <div className='text-xs text-slate-600 dark:text-slate-300'>
                                  {codecLabel(file.videoCodec)}
                                </div>
                                <div className='text-[10px] text-slate-400'>
                                  {file.width}x{file.height}
                                  {file.fps > 0 ? ` · ${file.fps.toFixed(2)} fps` : ''}
                                </div>
                              </td>
                              <td className='whitespace-nowrap px-2 py-2 text-xs text-slate-600 dark:text-slate-300'>
                                {formatBitrate(file.videoBitrateBps)}
                              </td>
                              <td className='whitespace-nowrap px-2 py-2'>
                                <div className='text-xs text-slate-600 dark:text-slate-300'>
                                  {formatDuration(file.durationMs)}
                                </div>
                                <div className='text-[10px] text-slate-400'>
                                  {formatBytes(file.sizeBytes)}
                                </div>
                              </td>
                              <td className='whitespace-nowrap px-2 py-2'>
                                <div className='flex flex-wrap gap-1'>
                                  {file.isHdr && (
                                    <span className='rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning'>
                                      HDR
                                    </span>
                                  )}
                                  {file.bitDepth > 8 && (
                                    <span className='rounded-full bg-default-100 px-1.5 py-0.5 text-[10px] text-default-600 dark:bg-white/[0.06] dark:text-default-300'>
                                      {file.bitDepth}-bit
                                    </span>
                                  )}
                                  {!file.isHdr && file.bitDepth <= 8 && (
                                    <span className='text-[10px] text-slate-300 dark:text-slate-600'>—</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {scanResult.files.length > SCAN_PAGE_SIZE && (
                    <div className='flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/60 px-4 py-2 text-[11px] text-slate-500 dark:border-white/[0.06] dark:text-slate-400'>
                      <span>
                        第 {scanPage + 1} / {scanPageCount} 页，共{' '}
                        {scanResult.files.length} 个文件
                      </span>
                      <div className='flex items-center gap-1'>
                        <Button
                          size='sm'
                          variant='light'
                          isDisabled={scanPage <= 0}
                          onPress={() =>
                            setScanPage((page) => Math.max(0, page - 1))
                          }
                        >
                          上一页
                        </Button>
                        <Button
                          size='sm'
                          variant='light'
                          isDisabled={scanPage >= scanPageCount - 1}
                          onPress={() =>
                            setScanPage((page) =>
                              Math.min(scanPageCount - 1, page + 1)
                            )
                          }
                        >
                          下一页
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div
              className={clsx(
                'space-y-4',
                activeTab !== 'settings' && 'hidden',
                activeTab === 'settings' &&
                  'xl:grid xl:grid-cols-2 xl:items-start xl:gap-4 xl:space-y-0'
              )}
            >
              <div className='glass-card p-4'>
                <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
                  输出设置
                </div>
                <div className='mt-3 grid gap-3'>
                  <SelectField
                    label='目标编码'
                    value={targetCodec}
                    onChange={(value) => {
                      setTargetCodec(value);
                      setEncoderChoice('auto');
                    }}
                    options={
                      codecOptions.length > 0
                        ? codecOptions
                        : [{ value: targetCodec, label: codecLabel(targetCodec) }]
                    }
                  />
                  <SelectField
                    label='编码器'
                    value={encoderChoice}
                    onChange={setEncoderChoice}
                    options={encoderOptions}
                    hint={encoderHint}
                  />
                  <div className='grid gap-3 sm:grid-cols-2'>
                    <SelectField
                      label='容器'
                      value={container}
                      onChange={setContainer}
                      options={
                        targetCodec === 'vp9' || targetCodec === 'vp8'
                          ? [{ value: 'mkv', label: 'MKV' }]
                          : [
                              { value: 'mp4', label: 'MP4' },
                              { value: 'mkv', label: 'MKV' },
                            ]
                      }
                      hint={
                        targetCodec === 'vp9' || targetCodec === 'vp8'
                          ? 'VP9/VP8 需要 MKV'
                          : undefined
                      }
                    />
                    <SelectField
                      label='分辨率'
                      value={resolution}
                      onChange={setResolution}
                      options={[
                        { value: 'source', label: '原始（不改变）' },
                        { value: '2160p', label: '2160p / 4K' },
                        { value: '1440p', label: '1440p / 2K' },
                        { value: '1080p', label: '1080p' },
                        { value: '720p', label: '720p' },
                        { value: '480p', label: '480p' },
                        { value: '360p', label: '360p' },
                        { value: 'custom', label: '自定义' },
                      ]}
                    />
                  </div>

                  {resolution === 'custom' && (
                    <div className='grid grid-cols-2 gap-3'>
                      <Input
                        size='sm'
                        label='宽'
                        type='number'
                        value={customWidth}
                        onValueChange={setCustomWidth}
                        placeholder='留空自动'
                      />
                      <Input
                        size='sm'
                        label='高'
                        type='number'
                        value={customHeight}
                        onValueChange={setCustomHeight}
                        placeholder='留空自动'
                      />
                    </div>
                  )}

                  <div className='grid gap-3 sm:grid-cols-2'>
                    <SelectField
                      label='码率 / 质量'
                      value={bitrateMode}
                      onChange={setBitrateMode}
                      options={[
                        { value: 'source', label: '与原视频相同（默认）' },
                        { value: 'crf', label: 'CRF 恒定质量' },
                        { value: 'custom', label: '自定义码率' },
                      ]}
                      hint={
                        averageBitrate > 0
                          ? `选中视频平均 ${formatBitrate(averageBitrate)}`
                          : undefined
                      }
                    />
                    {bitrateMode === 'custom' ? (
                      <Input
                        size='sm'
                        label='目标码率（Mbps）'
                        type='number'
                        value={bitrateMbps}
                        onValueChange={setBitrateMbps}
                        endContent={<span className='text-xs text-slate-400'>Mbps</span>}
                      />
                    ) : bitrateMode === 'crf' ? (
                      <Input
                        size='sm'
                        label={`CRF 值（0–${maxCrf}）`}
                        type='number'
                        value={String(crf)}
                        onValueChange={(value) => setCrf(Number(value))}
                        max={maxCrf}
                        endContent={
                          <span className='text-xs text-slate-400'>
                            推荐 {recommendedCrf}
                          </span>
                        }
                      />
                    ) : (
                      <div className='flex items-end pb-1 text-[11px] text-slate-400 dark:text-slate-500'>
                        每文件沿用自身视频码率
                      </div>
                    )}
                  </div>
                  {bitrateMode === 'crf' && (
                    <div
                      className={clsx(
                        'rounded-xl px-3 py-2 text-[11px] leading-relaxed',
                        crfAvailable
                          ? 'bg-default-100/60 text-slate-500 dark:bg-white/[0.04] dark:text-slate-400'
                          : 'bg-danger/10 text-danger'
                      )}
                    >
                      {crfAvailable
                        ? `CRF 越小越清晰、文件越大；H.264 推荐 23，HEVC 推荐 26，AV1 推荐 30。当前编码器 ${activeEncoderName ?? '自动'} 支持 CRF。`
                        : `当前编码器 ${activeEncoderName ?? '未知'} 不支持 CRF，请改用“与原视频相同”或自定义码率。`}
                    </div>
                  )}

                  <SelectField
                    label='音频'
                    value={audio}
                    onChange={setAudio}
                    options={[
                      { value: 'copy', label: '复制（不兼容时转 AAC）' },
                      { value: 'aac', label: 'AAC 192 kbps' },
                      { value: 'none', label: '移除音频' },
                    ]}
                  />

                  <div className='flex items-center justify-between gap-3 rounded-2xl bg-white/40 px-3 py-2.5 dark:bg-white/[0.03]'>
                    <div>
                      <div className='text-sm text-slate-800 dark:text-slate-100'>HDR 转 SDR</div>
                      <div className='text-[11px] text-slate-500 dark:text-slate-400'>
                        HDR 源默认做色调映射，避免转成 8-bit 后偏色
                      </div>
                    </div>
                    <Switch size='sm' isSelected={hdrToSdr} onValueChange={setHdrToSdr} />
                  </div>
                  {selectedHdr && !hdrToSdr && (
                    <div className='rounded-xl bg-warning/10 px-3 py-2 text-[11px] text-warning'>
                      选中了 HDR 视频但关闭了色调映射，输出可能出现色彩发灰或过曝。
                    </div>
                  )}
                  {selectedHdr &&
                    hdrToSdr &&
                    status &&
                    !status.buildConfig.includes('--enable-libzimg') && (
                      <div className='rounded-xl bg-danger/10 px-3 py-2 text-[11px] text-danger'>
                        当前 ffmpeg 未编译 zimg，HDR 转 SDR 会失败。请更换带 libzimg 的完整构建，或取消 HDR 文件。
                      </div>
                    )}
                  <div className='rounded-xl bg-default-100/60 px-3 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-white/[0.04] dark:text-slate-400'>
                    当前版本统一输出 8-bit yuv420p，10-bit 源会被转换；字幕不会写入输出文件。需要保留 10-bit 或字幕时请等待后续版本。
                  </div>
                </div>
              </div>

              <div className='glass-card p-4'>
                <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
                  任务设置
                </div>
                <div className='mt-3 space-y-3'>
                  <div className='flex items-center justify-between gap-3 rounded-2xl bg-white/40 px-3 py-2.5 dark:bg-white/[0.03]'>
                    <div>
                      <div className='text-sm text-slate-800 dark:text-slate-100'>输出位置</div>
                      <div className='text-[11px] text-slate-500 dark:text-slate-400'>
                        {outputMode === 'same' ? '与原视频同一文件夹' : outputDir || '尚未选择'}
                      </div>
                    </div>
                    <div className='flex items-center gap-2'>
                      {outputMode === 'custom' && (
                        <Button size='sm' variant='flat' onPress={() => setBrowseTarget('output')}>
                          浏览
                        </Button>
                      )}
                      <Switch
                        size='sm'
                        isSelected={outputMode === 'custom'}
                        onValueChange={(value) => setOutputMode(value ? 'custom' : 'same')}
                      />
                    </div>
                  </div>
                  {outputMode === 'custom' && (
                    <Input
                      size='sm'
                      aria-label='输出文件夹'
                      value={outputDir}
                      onValueChange={setOutputDir}
                      placeholder='输出文件夹绝对路径'
                      classNames={{ inputWrapper: 'bg-white/60 dark:bg-white/[0.04]' }}
                    />
                  )}

                  <div className='grid grid-cols-2 gap-3'>
                    <SelectField
                      label='并发转码数'
                      value={String(concurrency)}
                      onChange={(value) => setConcurrency(Number(value))}
                      options={[1, 2, 3, 4].map((value) => ({
                        value: String(value),
                        label: `${value} 个任务`,
                      }))}
                    />
                    <label className='block'>
                      <span className='text-xs font-medium text-slate-600 dark:text-slate-300'>
                        CPU 核心限制
                      </span>
                      <span className='mt-1 block'>
                        <input
                          type='number'
                          min={0}
                          max={64}
                          value={cpuThreads}
                          onChange={(event) => setCpuThreads(event.target.value)}
                          placeholder='0 = 自动'
                          className='w-full rounded-xl border border-slate-200/80 bg-white/70 px-3 py-2 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100'
                        />
                      </span>
                      <span className='mt-1 block text-[11px] leading-relaxed text-slate-400 dark:text-slate-500'>
                        限制 ffmpeg 线程数，0 表示自动
                      </span>
                    </label>
                  </div>
                  <div className='text-[11px] text-slate-400 dark:text-slate-500'>
                    硬件编码建议 1–2 路并发，避免会话数或显存不足；CPU 核心限制对硬件编码主要约束解码与滤镜线程。
                  </div>

                  <div className='flex items-center justify-between gap-3 rounded-2xl bg-white/40 px-3 py-2.5 dark:bg-white/[0.03]'>
                    <div>
                      <div className='text-sm text-slate-800 dark:text-slate-100'>
                        转码成功后删除原文件
                      </div>
                      <div className='text-[11px] text-slate-500 dark:text-slate-400'>
                        失败或取消不会删除；删除后不可恢复
                      </div>
                    </div>
                    <Switch
                      size='sm'
                      color='danger'
                      isSelected={deleteOriginal}
                      onValueChange={(value) => {
                        if (value) setDeleteConfirmOpen(true);
                        else setDeleteOriginal(false);
                      }}
                    />
                  </div>

                  <div className='flex items-center justify-between gap-2 pt-1 text-xs text-slate-500 dark:text-slate-400'>
                    <span>
                      已选 {selectedFiles.length} 个文件
                      {estimatedTotal > 0 ? `，预计输出 ${formatBytes(estimatedTotal)}` : ''}
                    </span>
                  </div>
                  <Button
                    className='w-full'
                    color='primary'
                    isDisabled={
                      selectedFiles.length === 0 ||
                      (bitrateMode === 'crf' && !crfAvailable)
                    }
                    isLoading={starting}
                    onPress={() => void start()}
                    startContent={<MdPlayArrow size={18} />}
                  >
                    开始转码
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className={clsx('space-y-3', activeTab !== 'jobs' && 'hidden')}>
            <div className='flex flex-wrap items-center justify-between gap-2 px-1'>
              <div className='flex flex-wrap items-center gap-3'>
                <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
                  转码任务
                </div>
                <div className='flex flex-wrap gap-1.5 text-[11px]'>
                  <span className='rounded-full bg-primary/10 px-2 py-0.5 text-primary'>进行中 {runningCount}</span>
                  <span className='rounded-full bg-secondary/15 px-2 py-0.5 text-secondary-700 dark:text-secondary-300'>排队 {queuedCount}</span>
                  <span className='rounded-full bg-success/10 px-2 py-0.5 text-success'>完成 {doneCount}</span>
                  <span className='rounded-full bg-danger/10 px-2 py-0.5 text-danger'>失败 {failedCount}</span>
                </div>
              </div>
              <Button
                size='sm'
                variant='flat'
                isLoading={clearing}
                isDisabled={jobs.length === 0}
                onPress={() => void clearFinished()}
                startContent={<MdDeleteOutline size={16} />}
              >
                清理已结束
              </Button>
            </div>

            {allFinished && (
              <div className='glass-card flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[11px] text-slate-600 dark:text-slate-300'>
                <span className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
                  全部任务已结束
                </span>
                <span>
                  成功 {doneCount} 个
                  {failedCount > 0 ? ` · 失败 ${failedCount}` : ''}
                  {canceledCount > 0 ? ` · 取消 ${canceledCount}` : ''}
                </span>
                {totalSourceBytes > 0 && (
                  <>
                    <span>
                      总大小 {formatBytes(totalSourceBytes)} →{' '}
                      {formatBytes(totalOutputBytes)}
                    </span>
                    <span
                      className={clsx(
                        'font-medium',
                        totalSizeDelta != null && totalSizeDelta <= 0
                          ? 'text-success'
                          : 'text-warning'
                      )}
                    >
                      {totalSizeDelta == null
                        ? ''
                        : Math.abs(totalSizeDelta) < 0.05
                          ? '总大小基本不变'
                          : `总${totalSizeDelta < 0 ? '节省' : '增大'} ${Math.abs(totalSizeDelta).toFixed(1)}%`}
                    </span>
                  </>
                )}
              </div>
            )}

            {activeJobs && <StatsPanel stats={stats} />}

            {jobs.length === 0 ? (
              <div className='glass-card p-6 text-center text-sm text-slate-500 dark:text-slate-400'>
                还没有转码任务。扫描并选择文件后，点击“开始转码”。
              </div>
            ) : (
              <div className='glass-card overflow-hidden'>
                <div className='max-h-[min(520px,52vh)] min-h-[120px] divide-y divide-slate-200/60 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] dark:divide-white/[0.06]'>
                  {jobs.map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      onCancel={(id) => void cancelJob(id)}
                      onRetry={(id) => void retryJob(id)}
                    />
                  ))}
                </div>
                <div className='border-t border-slate-200/60 px-4 py-1.5 text-[10px] text-slate-400 dark:border-white/[0.06] dark:text-slate-500'>
                  共 {jobs.length} 个任务 · 进行中 {runningCount} · 列表区域可滚动，运行中任务置顶
                </div>
              </div>
            )}
          </div>

          {activeTab === 'capabilities' && (
            <>
              <div className='glass-card flex flex-wrap items-center justify-between gap-2 p-4'>
                <div>
                  <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
                    能力检测
                  </div>
                  <div className='text-[11px] text-slate-500 dark:text-slate-400'>
                    查看 ffmpeg 版本、显卡与编解码能力，运行硬件自检
                  </div>
                </div>
                <Button
                  size='sm'
                  variant='flat'
                  isLoading={testing}
                  onPress={() => void runSelfTest()}
                  startContent={<MdSpeed size={16} />}
                >
                  硬件自检
                </Button>
              </div>
              {pathEditor}
              <div className='glass-card overflow-hidden'>
                <button
                  type='button'
                  className='flex w-full items-center justify-between gap-3 px-5 py-4 text-left'
                  onClick={() => setDetailsOpen((value) => !value)}
                >
              <div>
                <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
                  ffmpeg 与硬件能力详情
                </div>
                <div className='text-[11px] text-slate-500 dark:text-slate-400'>
                  版本、构建选项、显卡、硬件加速与完整编解码列表
                </div>
              </div>
              <MdExpandMore
                size={20}
                className={clsx('text-slate-400 transition', detailsOpen && 'rotate-180')}
              />
            </button>
            {detailsOpen && (
              <div className='space-y-4 border-t border-slate-200/60 p-5 dark:border-white/[0.06]'>
                <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
                  <InfoTile label='版本' value={status.version ?? '未知'} />
                  <InfoTile label='ffprobe' value={status.ffprobePath ? '已找到' : '未找到'} />
                  <InfoTile label='平台' value={`${status.platform} · ${status.arch}`} />
                  <InfoTile label='检测耗时' value={`${status.probeMs} ms`} />
                </div>
                <div
                  className='truncate rounded-xl bg-default-100/60 px-3 py-2 text-xs text-slate-600 dark:bg-white/[0.04] dark:text-slate-300'
                  title={status.path ?? ''}
                >
                  <span className='text-slate-400'>路径 </span>
                  {status.path}
                </div>
                {status.buildConfig.length > 0 && (
                  <div className='flex flex-wrap gap-1.5'>
                    {status.buildConfig.map((flag) => (
                      <span
                        key={flag}
                        title={flag}
                        className='rounded-full bg-default-100 px-2 py-0.5 text-[10px] text-default-600 dark:bg-white/[0.06] dark:text-default-300'
                      >
                        {flag.replace('--enable-', '')}
                      </span>
                    ))}
                  </div>
                )}
                {status.error && (
                  <p className='break-words rounded-xl bg-warning/10 px-3 py-2 text-xs text-warning'>
                    {status.error}
                  </p>
                )}

                <section>
                  <SectionHeader
                    icon={<MdMemory size={18} />}
                    title='显卡'
                    subtitle='从系统枚举，用于把硬件加速方式对应到厂商'
                  />
                  {status.gpus.length > 0 ? (
                    <div className='grid gap-3 md:grid-cols-2 lg:grid-cols-3'>
                      {status.gpus.map((gpu) => (
                        <GpuCard key={`${gpu.vendor}-${gpu.name}-${gpu.bus ?? ''}`} gpu={gpu} />
                      ))}
                    </div>
                  ) : (
                    <div className='rounded-2xl bg-white/40 p-4 text-xs text-slate-500 dark:bg-white/[0.03] dark:text-slate-400'>
                      无法枚举显卡。这不影响软件编码检测，但硬件加速状态只能以 ffmpeg 声明的能力为准。
                    </div>
                  )}
                </section>

                <section>
                  <SectionHeader
                    icon={<MdSpeed size={18} />}
                    title='硬件加速'
                    subtitle='点击“硬件自检”会用 H.264 做 1 帧测试编码验证设备是否真的可用'
                  />
                  {status.devices.length > 0 ? (
                    <div className='grid gap-3 md:grid-cols-2 lg:grid-cols-3'>
                      {status.devices.map((device) => (
                        <DeviceCard key={device.accel} device={device} />
                      ))}
                    </div>
                  ) : (
                    <div className='rounded-2xl bg-white/40 p-4 text-xs text-slate-500 dark:bg-white/[0.03] dark:text-slate-400'>
                      这个 ffmpeg 构建没有报告任何硬件加速方式。
                    </div>
                  )}
                </section>

                <section>
                  <SectionHeader
                    icon={<MdMovieFilter size={18} />}
                    title='编解码支持'
                    subtitle='软件实现与硬件实现分开列出；灰色硬件项表示当前设备不可用或未通过自检'
                  />
                  <div className='overflow-hidden rounded-2xl border border-white/60 dark:border-white/[0.06]'>
                    <div className='overflow-x-auto'>
                      <table className='w-full min-w-[720px] border-collapse text-left text-sm'>
                        <thead>
                          <tr className='border-b border-slate-200/70 text-[11px] uppercase tracking-wider text-slate-400 dark:border-white/[0.07]'>
                            <th className='px-4 py-3 font-semibold'>格式</th>
                            <th className='px-4 py-3 font-semibold'>解码</th>
                            <th className='px-4 py-3 font-semibold'>编码</th>
                          </tr>
                        </thead>
                        <tbody>
                          {status.codecs.map((codec) => {
                            const empty =
                              codec.decode.software.length === 0 &&
                              codec.decode.hardware.length === 0 &&
                              codec.encode.software.length === 0 &&
                              codec.encode.hardware.length === 0;
                            return (
                              <tr
                                key={codec.codec}
                                className={clsx(
                                  'border-b border-slate-200/50 align-top last:border-0 dark:border-white/[0.05]',
                                  empty && 'opacity-50'
                                )}
                              >
                                <td className='whitespace-nowrap px-4 py-3'>
                                  <div className='font-medium text-slate-800 dark:text-slate-100'>
                                    {codec.label}
                                  </div>
                                  <div className='text-[10px] text-slate-400'>{codec.codec}</div>
                                </td>
                                <td className='px-4 py-3'>
                                  <CodecCell impls={codec.decode} usableAccels={usableAccels} />
                                </td>
                                <td className='px-4 py-3'>
                                  <CodecCell impls={codec.encode} usableAccels={usableAccels} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </section>

              </div>
            )}
              </div>
            </>
          )}

          <p className='px-1 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500'>
            转码在服务器上运行，浏览器只负责显示进度。硬件加速状态以 ffmpeg 声明和可选自检结果为准；任务列表保存在内存中，服务重启后清空。
          </p>
        </>
      )}

      <StorageBrowser
        open={browseTarget !== null}
        onClose={() => setBrowseTarget(null)}
        initialPath={browseTarget === 'output' ? outputDir || scanDir : scanDir}
        title={browseTarget === 'output' ? '选择输出文件夹' : '选择要扫描的文件夹'}
        onSelect={(path) => {
          if (browseTarget === 'output') setOutputDir(path);
          else setScanDir(path);
          setBrowseTarget(null);
        }}
      />

      <ConfirmDialog
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        title='转码成功后删除原文件'
        description='只有转码成功并确认输出文件有效后才会删除原文件；失败或取消不会删除。此操作不可恢复。'
        confirmLabel='启用删除'
        danger
        onConfirm={() => setDeleteOriginal(true)}
      />
    </div>
  );
}
