import { Button } from '@heroui/button';
import { Input } from '@heroui/input';
import { Switch } from '@heroui/switch';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MdCancel,
  MdDeleteOutline,
  MdFolderOpen,
  MdImage,
  MdPause,
  MdPlayArrow,
  MdReplay,
  MdSearch,
  MdWarningAmber,
} from 'react-icons/md';
import toast from 'react-hot-toast';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StorageBrowser } from '@/components/StorageBrowser';
import { VendorLogo } from '@/components/VendorLogo';
import { useApp } from '@/context/app';
import { api, imageEventsUrl } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import type {
  CreateImageJobsRequest,
  ImageEvent,
  ImageJobView,
  ImageScanResult,
  TranscodeStats,
} from '@/lib/types';

const PAGE_SIZE = 100;

function sortJobs(jobs: ImageJobView[]): ImageJobView[] {
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

function upsertJob(jobs: ImageJobView[], job: ImageJobView): ImageJobView[] {
  const index = jobs.findIndex((item) => item.id === job.id);
  if (index < 0) return sortJobs([job, ...jobs]);
  const next = jobs.slice();
  next[index] = job;
  return sortJobs(next);
}

function statusChip(status: string) {
  switch (status) {
    case 'running':
      return { label: '转换中', className: 'bg-primary/10 text-primary' };
    case 'queued':
      return {
        label: '排队中',
        className: 'bg-secondary/15 text-secondary-700 dark:text-secondary-300',
      };
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

function StatsBar({ stats }: { stats: TranscodeStats | null }) {
  if (!stats) return null;
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
        内存 {formatBytes(stats.memoryUsedBytes)} / {formatBytes(stats.memoryTotalBytes)}
      </span>
      {stats.gpus.map((gpu) => (
        <span
          key={`${gpu.index}-${gpu.name}`}
          className='inline-flex items-center gap-1.5 rounded-full bg-white/50 px-2 py-1 dark:bg-white/[0.04]'
          title={gpu.name}
        >
          <VendorLogo vendor={gpu.vendor} size='xs' />
          <span className='max-w-[120px] truncate'>{gpu.name}</span>
          <span className='font-semibold text-primary'>
            {gpu.utilization == null ? '—' : `${gpu.utilization.toFixed(0)}%`}
          </span>
        </span>
      ))}
    </div>
  );
}

function ImageJobRow({
  job,
  onCancel,
  onRetry,
}: {
  job: ImageJobView;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const chip = statusChip(job.status);
  const active = job.status === 'running' || job.status === 'queued';
  const done = job.status === 'done';
  const saved = job.sourceBytes - job.outputBytes;
  const delta =
    done && job.sourceBytes > 0
      ? (saved / job.sourceBytes) * 100
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
    <div className='px-4 py-3 [content-visibility:auto] [contain-intrinsic-size:92px]'>
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
        {job.lossless && (
          <span className='hidden shrink-0 rounded-full bg-secondary/15 px-2 py-0.5 text-[10px] text-secondary-700 sm:inline dark:text-secondary-300'>
            无损
          </span>
        )}
        {job.deleteOriginal && (
          <span
            className='hidden shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] text-danger sm:inline'
            title='转换成功后删除原文件'
          >
            删除原图
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
        {job.sourceFormat} {job.width}x{job.height} → WebP · 质量 {job.quality}
        {job.frames > 1 ? ` · ${job.frames} 帧` : ''}
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
          {job.progress.toFixed(0)}%
        </span>
      </div>

      <div className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400'>
        {active && <span>等待转换完成…</span>}
        {done && (
          <>
            <span>
              大小 {formatBytes(job.sourceBytes)} → {formatBytes(job.outputBytes)}
              {delta != null && (
                <span
                  className={clsx(
                    'ml-1 font-medium',
                    delta >= 0 ? 'text-success' : 'text-warning'
                  )}
                >
                  {Math.abs(delta) < 0.05
                    ? '大小不变'
                    : `${delta >= 0 ? '节省' : '增大'} ${Math.abs(delta).toFixed(1)}%`}
                </span>
              )}
            </span>
            {job.frames > 1 && <span>{job.frames} 帧动画</span>}
          </>
        )}
        {!active && !done && <span>输出 {formatBytes(job.outputBytes)}</span>}
      </div>

      {(job.error || job.note) && (
        <div
          className={clsx(
            'mt-1 line-clamp-2 break-words text-[11px]',
            job.error ? 'text-danger' : 'text-slate-500 dark:text-slate-400'
          )}
          title={job.error ?? job.note ?? ''}
        >
          {job.error ? `错误：${job.error}` : job.note}
        </div>
      )}
    </div>
  );
}

export function ImageConvertPanel() {
  const { settings } = useApp();
  const [scanDir, setScanDir] = useState(() => {
    try {
      const stored = window.localStorage.getItem('wcdc.convert.scanDir');
      if (stored && stored.trim()) return stored;
    } catch {
      // localStorage may be unavailable.
    }
    return settings?.downloadDir ?? '';
  });
  useEffect(() => {
    try {
      const value = scanDir.trim();
      if (value) window.localStorage.setItem('wcdc.convert.scanDir', value);
      else window.localStorage.removeItem('wcdc.convert.scanDir');
    } catch {
      // Ignore storage errors.
    }
  }, [scanDir]);

  const [recursive, setRecursive] = useState(true);
  const [minSizeMb, setMinSizeMb] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ImageScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [browseTarget, setBrowseTarget] = useState<'scan' | 'output' | null>(null);

  const [quality, setQuality] = useState(80);
  const [lossless, setLossless] = useState(false);
  const [cpuThreads, setCpuThreads] = useState('0');
  const [concurrency, setConcurrency] = useState('2');
  const [deleteOriginal, setDeleteOriginal] = useState(true);
  const [outputMode, setOutputMode] = useState<'same' | 'custom'>('same');
  const [outputDir, setOutputDir] = useState('');
  const [starting, setStarting] = useState(false);

  const [jobs, setJobs] = useState<ImageJobView[]>([]);
  const [stats, setStats] = useState<TranscodeStats | null>(null);
  const [clearing, setClearing] = useState(false);
  const [queuePaused, setQueuePaused] = useState(false);
  const [cancelAllOpen, setCancelAllOpen] = useState(false);

  const loadJobs = useCallback(async () => {
    try {
      const [nextJobs, queue] = await Promise.all([
        api.imageJobs(),
        api.imageQueueState(),
      ]);
      setJobs(sortJobs(nextJobs));
      setQueuePaused(queue.paused);
    } catch {
      // SSE and later polling retry.
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    const source = new EventSource(imageEventsUrl, { withCredentials: true });
    source.onmessage = (message) => {
      let event: ImageEvent;
      try {
        event = JSON.parse(message.data) as ImageEvent;
      } catch {
        return;
      }
      if (event.type === 'imageJobUpdated') {
        setJobs((current) => upsertJob(current, event.job));
      } else if (event.type === 'imageJobsCleared') {
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

  const pageCount = scanResult
    ? Math.max(1, Math.ceil(scanResult.files.length / PAGE_SIZE))
    : 1;
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  const visibleFiles = useMemo(() => {
    if (!scanResult) return [];
    const start = page * PAGE_SIZE;
    return scanResult.files.slice(start, start + PAGE_SIZE);
  }, [scanResult, page]);

  const selectedFiles = useMemo(
    () => scanResult?.files.filter((file) => selected.has(file.path)) ?? [],
    [scanResult, selected]
  );
  const allSelected =
    !!scanResult &&
    scanResult.files.length > 0 &&
    selected.size === scanResult.files.length;

  const scan = async () => {
    if (!scanDir.trim()) {
      toast.error('请选择要扫描的文件夹');
      return;
    }
    setScanning(true);
    try {
      const result = await api.imageScan({
        directory: scanDir.trim(),
        recursive,
        minSizeBytes:
          Number(minSizeMb) > 0
            ? Math.round(Number(minSizeMb) * 1024 * 1024)
            : null,
      });
      setScanResult(result);
      setSelected(new Set(result.files.map((file) => file.path)));
      setPage(0);
      if (result.errors.length > 0) {
        toast.error(`扫描完成，但有 ${result.errors.length} 个图片读取失败`);
      } else {
        toast.success(`扫描完成：找到 ${result.matched} 张图片`);
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
    if (selectedFiles.length === 0) {
      toast.error('请先选择要转换的图片');
      return;
    }
    if (!Number.isFinite(quality) || quality < 0 || quality > 100) {
      toast.error('WebP 质量应在 0–100 之间');
      return;
    }
    if (outputMode === 'custom' && !outputDir.trim()) {
      toast.error('请选择输出文件夹');
      return;
    }
    const payload: CreateImageJobsRequest = {
      files: selectedFiles.map((file) => file.path),
      quality: Math.round(quality),
      lossless,
      concurrency: Math.max(1, Number(concurrency) || 2),
      cpuThreads: Number(cpuThreads) > 0 ? Number(cpuThreads) : undefined,
      deleteOriginal,
      outputDir: outputMode === 'custom' ? outputDir.trim() : null,
    };
    setStarting(true);
    try {
      const created = await api.imageCreateJobs(payload);
      setJobs((current) => sortJobs([...created, ...current]));
      setSelected(new Set());
      toast.success(`已加入 ${created.length} 个图片转换任务`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建图片任务失败');
    } finally {
      setStarting(false);
    }
  };

  const cancelJob = async (id: string) => {
    try {
      await api.imageCancelJob(id);
      toast.success('已请求取消');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消失败');
    }
  };

  const retryJob = async (id: string) => {
    try {
      const created = await api.imageRetryJob(id);
      setJobs((current) => sortJobs([...created, ...current]));
      toast.success('已重新加入队列');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重试失败');
    }
  };

  const pauseAll = async () => {
    try {
      const result = await api.imagePauseAll();
      setQueuePaused(true);
      toast.success(
        result.affected > 0
          ? `已暂停，后续 ${result.affected} 个任务不会启动`
          : '已暂停'
      );
      void loadJobs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '暂停失败');
    }
  };

  const resumeAll = async () => {
    try {
      await api.imageResumeAll();
      setQueuePaused(false);
      toast.success('已继续图片转换');
      void loadJobs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '继续失败');
    }
  };

  const cancelAll = async () => {
    try {
      const result = await api.imageCancelAll();
      setQueuePaused(false);
      toast.success(`已请求取消 ${result.canceled} 个任务`);
      window.setTimeout(() => void loadJobs(), 300);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '全部取消失败');
    }
  };

  const clearFinished = async () => {
    setClearing(true);
    try {
      const result = await api.imageClearJobs();
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
  const doneJobs = jobs.filter((job) => job.status === 'done');
  const totalSourceBytes = doneJobs.reduce((sum, job) => sum + job.sourceBytes, 0);
  const totalOutputBytes = doneJobs.reduce((sum, job) => sum + job.outputBytes, 0);
  const savedBytes = totalSourceBytes - totalOutputBytes;
  const savedPercent =
    totalSourceBytes > 0 ? (savedBytes / totalSourceBytes) * 100 : null;

  return (
    <div className='space-y-4'>
      <div className='glass-card p-4'>
        <div className='flex flex-wrap items-start gap-3'>
          <div className='flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary'>
            <MdImage size={24} />
          </div>
          <div className='min-w-0 flex-1'>
            <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
              图片格式转换 · WebP
            </div>
            <p className='mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400'>
              使用 zenwebp 将目录中的非 WebP 图片（JPEG / PNG / GIF / BMP / TIFF 等）转为 WebP。
              默认转换成功后删除原文件；输出文件沿用原文件名，扩展名改为 .webp。
            </p>
          </div>
        </div>
      </div>

      <div className='grid gap-4 xl:grid-cols-2 xl:items-start'>
        <div className='glass-card p-4'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div>
              <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
                扫描图片
              </div>
              <div className='text-[11px] text-slate-500 dark:text-slate-400'>
                目录中的 WebP 文件会自动跳过
              </div>
            </div>
            <div className='flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400'>
              <span>递归</span>
              <Switch size='sm' isSelected={recursive} onValueChange={setRecursive} />
            </div>
          </div>

          <div className='mt-3 flex flex-col gap-2 md:flex-row'>
            <Input
              aria-label='图片扫描文件夹'
              size='sm'
              value={scanDir}
              onValueChange={setScanDir}
              placeholder='图片所在文件夹的绝对路径'
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

          <div className='mt-3 grid gap-3 sm:grid-cols-2'>
            <Input
              size='sm'
              label='最小文件大小（MB）'
              type='number'
              min={0}
              value={minSizeMb}
              onValueChange={setMinSizeMb}
              placeholder='留空 = 不限制'
              description='只转换大于该大小的图片'
            />
            <div className='flex items-end pb-1 text-[11px] text-slate-400 dark:text-slate-500'>
              {scanResult
                ? `扫描 ${scanResult.scanned} 张${
                    scanResult.skippedBySize > 0
                      ? `（大小筛选排除 ${scanResult.skippedBySize} 张）`
                      : ''
                  }，匹配 ${scanResult.matched} 张，用时 ${scanResult.tookMs} ms`
                : '支持 JPEG、PNG、APNG、GIF、BMP、TIFF、ICO、TGA、QOI、HDR、EXR 等'}
            </div>
          </div>

          {scanResult && scanResult.errors.length > 0 && (
            <details className='mt-3'>
              <summary className='cursor-pointer text-[11px] text-danger'>
                {scanResult.errors.length} 个图片读取失败
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

        <div className='glass-card p-4'>
          <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
            转换设置
          </div>
          <div className='mt-3 space-y-3'>
            <div className='grid grid-cols-2 gap-3'>
              <Input
                size='sm'
                label='WebP 质量（0–100）'
                type='number'
                min={0}
                max={100}
                value={String(quality)}
                onValueChange={(value) => setQuality(Number(value))}
                description='80 通常兼顾体积与画质'
              />
              <div className='block'>
                <span className='text-xs font-medium text-slate-600 dark:text-slate-300'>
                  压缩模式
                </span>
                <div className='mt-1 flex items-center justify-between gap-2 rounded-xl bg-white/60 px-3 py-2 dark:bg-white/[0.04]'>
                  <span className='text-sm text-slate-700 dark:text-slate-200'>无损</span>
                  <Switch size='sm' isSelected={lossless} onValueChange={setLossless} />
                </div>
                <span className='mt-1 block text-[11px] leading-relaxed text-slate-400 dark:text-slate-500'>
                  关闭时按质量值有损压缩
                </span>
              </div>
            </div>
            <div className='grid grid-cols-2 gap-3'>
              <Input
                size='sm'
                label='同时转换数'
                type='number'
                min={1}
                max={16}
                value={concurrency}
                onValueChange={setConcurrency}
                description='1–16'
              />
              <Input
                size='sm'
                label='CPU 核心限制'
                type='number'
                min={0}
                max={64}
                value={cpuThreads}
                onValueChange={setCpuThreads}
                placeholder='0 = 自动'
                description='0 = 自动；会限制实际并发'
              />
            </div>
            <div className='rounded-xl bg-default-100/60 px-3 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-white/[0.04] dark:text-slate-400'>
              动画 GIF / APNG 会保留为动画 WebP。WebP 无损模式适合截图和图形，照片建议使用质量 75–85 的有损模式。
            </div>

            <div className='flex items-center justify-between gap-3 rounded-2xl bg-white/40 px-3 py-2.5 dark:bg-white/[0.03]'>
              <div>
                <div className='text-sm text-slate-800 dark:text-slate-100'>输出位置</div>
                <div className='text-[11px] text-slate-500 dark:text-slate-400'>
                  {outputMode === 'same' ? '与原图片同一文件夹' : outputDir || '尚未选择'}
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
                aria-label='图片输出文件夹'
                value={outputDir}
                onValueChange={setOutputDir}
                placeholder='输出文件夹绝对路径'
                classNames={{ inputWrapper: 'bg-white/60 dark:bg-white/[0.04]' }}
              />
            )}

            <div className='flex items-center justify-between gap-3 rounded-2xl bg-white/40 px-3 py-2.5 dark:bg-white/[0.03]'>
              <div>
                <div className='text-sm text-slate-800 dark:text-slate-100'>
                  转换成功后删除原文件
                </div>
                <div className='text-[11px] text-slate-500 dark:text-slate-400'>
                  默认开启；失败或取消不会删除
                </div>
              </div>
              <Switch
                size='sm'
                color='danger'
                isSelected={deleteOriginal}
                onValueChange={setDeleteOriginal}
              />
            </div>
            {deleteOriginal && (
              <div className='flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-warning'>
                <MdWarningAmber className='mt-0.5 shrink-0' size={15} />
                已选择删除原图。只有 WebP 写入成功并验证后才会删除，操作不可恢复。
              </div>
            )}

            <div className='flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-slate-500 dark:text-slate-400'>
              <span>已选 {selectedFiles.length} 张图片</span>
              <Button
                color='primary'
                isDisabled={selectedFiles.length === 0}
                isLoading={starting}
                onPress={() => void start()}
                startContent={<MdPlayArrow size={18} />}
              >
                开始转换
              </Button>
            </div>
          </div>
        </div>
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
            <Button size='sm' variant='light' onPress={toggleAll}>
              {allSelected ? '清空选择' : '全选'}
            </Button>
          </div>
          <div className='max-h-[380px] overflow-auto'>
            <table className='w-full min-w-[640px] border-collapse text-left text-sm'>
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
                  <th className='px-2 py-2 font-semibold'>格式 / 尺寸</th>
                  <th className='px-2 py-2 font-semibold'>大小</th>
                </tr>
              </thead>
              <tbody>
                {visibleFiles.map((file) => {
                  const checked = selected.has(file.path);
                  return (
                    <tr
                      key={file.path}
                      onClick={() => toggleSelected(file.path)}
                      className={clsx(
                        'cursor-pointer border-b border-slate-200/40 transition last:border-0 dark:border-white/[0.04]',
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
                      <td className='max-w-[320px] px-2 py-2'>
                        <div
                          className='truncate font-medium text-slate-800 dark:text-slate-100'
                          title={file.path}
                        >
                          {file.name}
                        </div>
                        <div className='truncate text-[10px] text-slate-400' title={file.path}>
                          {file.path}
                        </div>
                      </td>
                      <td className='whitespace-nowrap px-2 py-2 text-xs text-slate-600 dark:text-slate-300'>
                        {file.format} · {file.width}x{file.height}
                      </td>
                      <td className='whitespace-nowrap px-2 py-2 text-xs text-slate-600 dark:text-slate-300'>
                        {formatBytes(file.sizeBytes)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {scanResult.files.length > PAGE_SIZE && (
            <div className='flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/60 px-4 py-2 text-[11px] text-slate-500 dark:border-white/[0.06] dark:text-slate-400'>
              <span>
                第 {page + 1} / {pageCount} 页，共 {scanResult.files.length} 张图片
              </span>
              <div className='flex items-center gap-1'>
                <Button
                  size='sm'
                  variant='light'
                  isDisabled={page <= 0}
                  onPress={() => setPage((current) => Math.max(0, current - 1))}
                >
                  上一页
                </Button>
                <Button
                  size='sm'
                  variant='light'
                  isDisabled={page >= pageCount - 1}
                  onPress={() =>
                    setPage((current) => Math.min(pageCount - 1, current + 1))
                  }
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className='flex flex-wrap items-center justify-between gap-2 px-1'>
        <div className='flex flex-wrap items-center gap-3'>
          <div className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
            图片转换任务
          </div>
          <div className='flex flex-wrap gap-1.5 text-[11px]'>
            <span className='rounded-full bg-primary/10 px-2 py-0.5 text-primary'>
              进行中 {runningCount}
            </span>
            <span className='rounded-full bg-secondary/15 px-2 py-0.5 text-secondary-700 dark:text-secondary-300'>
              排队 {queuedCount}
            </span>
            <span className='rounded-full bg-success/10 px-2 py-0.5 text-success'>
              完成 {doneCount}
            </span>
            <span className='rounded-full bg-danger/10 px-2 py-0.5 text-danger'>
              失败 {failedCount}
            </span>
            {queuePaused && (
              <span className='rounded-full bg-warning/10 px-2 py-0.5 text-warning'>
                已暂停
              </span>
            )}
          </div>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            variant='flat'
            isDisabled={!activeJobs || queuePaused}
            onPress={() => void pauseAll()}
            startContent={<MdPause size={16} />}
          >
            全部暂停
          </Button>
          <Button
            size='sm'
            variant='flat'
            isDisabled={!queuePaused}
            onPress={() => void resumeAll()}
            startContent={<MdPlayArrow size={16} />}
          >
            全部继续
          </Button>
          <Button
            size='sm'
            variant='flat'
            color='danger'
            isDisabled={!activeJobs}
            onPress={() => setCancelAllOpen(true)}
            startContent={<MdCancel size={16} />}
          >
            全部取消
          </Button>
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
      </div>

      {allFinished && (
        <div className='glass-card flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[11px] text-slate-600 dark:text-slate-300'>
          <span className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
            全部图片已处理
          </span>
          <span>
            成功 {doneCount} 张
            {failedCount > 0 ? ` · 失败 ${failedCount}` : ''}
            {canceledCount > 0 ? ` · 取消 ${canceledCount}` : ''}
          </span>
          {totalSourceBytes > 0 && (
            <>
              <span>
                总大小 {formatBytes(totalSourceBytes)} → {formatBytes(totalOutputBytes)}
              </span>
              <span
                className={clsx(
                  'font-medium',
                  savedBytes >= 0 ? 'text-success' : 'text-warning'
                )}
              >
                {savedPercent == null
                  ? ''
                  : Math.abs(savedPercent) < 0.05
                    ? '总大小基本不变'
                    : `${savedBytes >= 0 ? '节省' : '增大'} ${formatBytes(
                        Math.abs(savedBytes)
                      )}（${Math.abs(savedPercent).toFixed(1)}%）`}
              </span>
            </>
          )}
        </div>
      )}

      {activeJobs && <StatsBar stats={stats} />}

      {jobs.length === 0 ? (
        <div className='glass-card p-6 text-center text-sm text-slate-500 dark:text-slate-400'>
          还没有图片转换任务。扫描并选择图片后，点击“开始转换”。
        </div>
      ) : (
        <div className='glass-card overflow-hidden'>
          <div className='max-h-[min(520px,52vh)] min-h-[120px] divide-y divide-slate-200/60 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] dark:divide-white/[0.06]'>
            {jobs.map((job) => (
              <ImageJobRow
                key={job.id}
                job={job}
                onCancel={(id) => void cancelJob(id)}
                onRetry={(id) => void retryJob(id)}
              />
            ))}
          </div>
          <div className='border-t border-slate-200/60 px-4 py-1.5 text-[10px] text-slate-400 dark:border-white/[0.06] dark:text-slate-500'>
            共 {jobs.length} 个任务 · 进行中 {runningCount} · 列表区域可滚动
          </div>
        </div>
      )}

      <ConfirmDialog
        open={cancelAllOpen}
        onClose={() => setCancelAllOpen(false)}
        title='取消全部图片转换任务'
        description='正在处理的当前图片会完成写入，排队中的任务会被取消。已完成的 WebP 文件不会删除。'
        confirmLabel='全部取消'
        danger
        onConfirm={() => {
          setCancelAllOpen(false);
          void cancelAll();
        }}
      />

      <StorageBrowser
        open={browseTarget !== null}
        onClose={() => setBrowseTarget(null)}
        initialPath={browseTarget === 'output' ? outputDir || scanDir : scanDir}
        title={browseTarget === 'output' ? '选择图片输出文件夹' : '选择要扫描的图片文件夹'}
        onSelect={(path) => {
          if (browseTarget === 'output') setOutputDir(path);
          else setScanDir(path);
          setBrowseTarget(null);
        }}
      />
    </div>
  );
}
