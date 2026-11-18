import { Button } from '@heroui/button';
import { Chip } from '@heroui/chip';
import { Spinner } from '@heroui/spinner';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MdArrowDownward,
  MdArrowUpward,
  MdDownload,
  MdOutlineRefresh,
  MdSpeed,
  MdTimer,
  MdWifiTethering,
} from 'react-icons/md';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';

import { EmptyState } from '@/components/EmptyState';
import { FileIcon } from '@/components/FileIcon';
import { useApp } from '@/context/app';
import { api, speedTest } from '@/lib/api';
import { formatBytes, formatDate, formatSpeed } from '@/lib/format';
import type { TransferView } from '@/lib/types';

const DOWNLOAD_BYTES = 24 * 1024 * 1024;
const UPLOAD_BYTES = 8 * 1024 * 1024;

interface SpeedResult {
  latency: number | null;
  down: number | null;
  up: number | null;
}

function toMbps(bytesPerSecond: number | null): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '—';
  return `${((bytesPerSecond * 8) / 1_000_000).toFixed(1)} Mbps`;
}

export default function DownloadsPage() {
  const { accounts } = useApp();
  const [items, setItems] = useState<TransferView[]>([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [phase, setPhase] = useState('');
  const [speed, setSpeed] = useState<SpeedResult>({ latency: null, down: null, up: null });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.completedDownloads());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取已下载文件失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const accountNames = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((account) => map.set(account.id, account.nickname || account.uid));
    return map;
  }, [accounts]);

  const runSpeedTest = async () => {
    if (testing) return;
    setTesting(true);
    setPhase('测量延迟…');
    setSpeed({ latency: null, down: null, up: null });
    try {
      const pings: number[] = [];
      for (let index = 0; index < 3; index += 1) {
        const started = performance.now();
        await fetch(speedTest.pingUrl(), { cache: 'no-store' });
        pings.push(performance.now() - started);
      }
      const latency = Math.min(...pings);
      setSpeed((current) => ({ ...current, latency }));

      setPhase('测量下行速度…');
      const downStarted = performance.now();
      const response = await fetch(speedTest.downloadUrl(DOWNLOAD_BYTES), {
        cache: 'no-store',
      });
      if (!response.ok || !response.body) {
        throw new Error(`测速请求失败（HTTP ${response.status}）`);
      }
      const reader = response.body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value?.byteLength ?? 0;
      }
      const downSeconds = (performance.now() - downStarted) / 1000;
      const down = received / Math.max(downSeconds, 0.01);
      setSpeed((current) => ({ ...current, down }));

      setPhase('测量上行速度…');
      const payload = new Blob([new Uint8Array(UPLOAD_BYTES)], {
        type: 'application/octet-stream',
      });
      const upStarted = performance.now();
      const upload = await fetch(speedTest.uploadUrl, {
        method: 'POST',
        body: payload,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!upload.ok) throw new Error(`上传测速失败（HTTP ${upload.status}）`);
      await upload.json();
      const upSeconds = (performance.now() - upStarted) / 1000;
      const up = UPLOAD_BYTES / Math.max(upSeconds, 0.01);
      setSpeed((current) => ({ ...current, up }));
      toast.success('测速完成');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '测速失败');
    } finally {
      setTesting(false);
      setPhase('');
    }
  };

  return (
    <div className='animate-float-in space-y-4'>
      <div className='glass-card overflow-hidden'>
        <div className='flex flex-wrap items-center gap-3 border-b border-slate-200/60 px-5 py-4 dark:border-white/[0.06]'>
          <span className='flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary'>
            <MdSpeed size={24} />
          </span>
          <div className='min-w-0 flex-1'>
            <div className='text-base font-semibold text-slate-900 dark:text-white'>
              服务器测速
            </div>
            <div className='text-xs text-slate-500 dark:text-slate-400'>
              测量浏览器 ↔ 本机服务端的真实带宽，与夸克服务器无关
            </div>
          </div>
          <Button
            color='primary'
            radius='full'
            isLoading={testing}
            onPress={() => void runSpeedTest()}
          >
            {testing ? phase || '测速中…' : '开始测速'}
          </Button>
        </div>

        <div className='grid gap-3 p-5 sm:grid-cols-3'>
          <div className='rounded-3xl border border-white/50 bg-white/50 p-4 dark:border-white/[0.06] dark:bg-white/[0.03]'>
            <div className='flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400'>
              <MdTimer size={16} /> 延迟
            </div>
            <div className='mt-2 text-2xl font-semibold text-slate-900 dark:text-white'>
              {speed.latency === null ? '—' : `${speed.latency.toFixed(0)} ms`}
            </div>
            <div className='mt-1 text-[11px] text-slate-400'>三次取最小值</div>
          </div>
          <div className='rounded-3xl border border-white/50 bg-white/50 p-4 dark:border-white/[0.06] dark:bg-white/[0.03]'>
            <div className='flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400'>
              <MdArrowDownward size={16} className='text-emerald-500' /> 下行
            </div>
            <div className='mt-2 text-2xl font-semibold text-slate-900 dark:text-white'>
              {formatSpeed(speed.down)}
            </div>
            <div className='mt-1 text-[11px] text-slate-400'>{toMbps(speed.down)}</div>
          </div>
          <div className='rounded-3xl border border-white/50 bg-white/50 p-4 dark:border-white/[0.06] dark:bg-white/[0.03]'>
            <div className='flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400'>
              <MdArrowUpward size={16} className='text-sky-500' /> 上行
            </div>
            <div className='mt-2 text-2xl font-semibold text-slate-900 dark:text-white'>
              {formatSpeed(speed.up)}
            </div>
            <div className='mt-1 text-[11px] text-slate-400'>{toMbps(speed.up)}</div>
          </div>
        </div>
        <div className='flex items-center gap-2 px-5 pb-4 text-[11px] text-slate-400'>
          <MdWifiTethering size={14} />
          下行测 {formatBytes(DOWNLOAD_BYTES)}，上行测 {formatBytes(UPLOAD_BYTES)}；结果受浏览器、反向代理和本机负载影响。
        </div>
      </div>

      <div className='glass-card overflow-hidden'>
        <div className='flex flex-wrap items-center gap-3 border-b border-slate-200/60 px-5 py-4 dark:border-white/[0.06]'>
          <div>
            <div className='text-base font-semibold text-slate-900 dark:text-white'>
              已下载文件
            </div>
            <div className='text-xs text-slate-500 dark:text-slate-400'>
              服务端已经从夸克下载完成的文件，可直接取回本机
            </div>
          </div>
          <div className='ml-auto flex items-center gap-2'>
            <Chip size='sm' variant='flat' className='bg-primary/10 text-primary'>
              {items.length} 个
            </Chip>
            <Button
              isIconOnly
              size='sm'
              radius='full'
              variant='light'
              onPress={() => void load()}
              aria-label='刷新'
            >
              <MdOutlineRefresh size={18} />
            </Button>
            <Button
              as={Link}
              to='/quark'
              size='sm'
              radius='full'
              color='primary'
              variant='flat'
            >
              去下载文件
            </Button>
          </div>
        </div>

        {loading && items.length === 0 ? (
          <div className='flex h-[240px] items-center justify-center'>
            <Spinner color='primary' label='正在读取已下载文件…' />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title='还没有已下载的文件'
            description='在「全部文件」中选择文件或文件夹，下载到服务器后，会在这里出现并可以取回本机。'
            action={
              <Button as={Link} to='/quark' color='primary' radius='full' size='sm'>
                浏览我的文件
              </Button>
            }
          />
        ) : (
          <div className='divide-y divide-slate-200/60 dark:divide-white/[0.06]'>
            {items.map((item) => (
              <div
                key={item.id}
                className='flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-center'
              >
                <div className='flex min-w-0 flex-1 items-center gap-3'>
                  <FileIcon name={item.remoteName} isDir={false} size='sm' />
                  <div className='min-w-0'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='truncate text-sm font-medium text-slate-800 dark:text-slate-100'>
                        {item.remoteName}
                      </span>
                      <Chip
                        size='sm'
                        variant='flat'
                        color='success'
                        className='h-5 text-[10px]'
                      >
                        已完成
                      </Chip>
                    </div>
                    <div className='mt-0.5 truncate font-mono text-[10px] text-slate-400' title={item.localPath}>
                      {item.localPath}
                    </div>
                    <div className='mt-0.5 text-[11px] text-slate-400'>
                      {accountNames.get(item.accountId) ?? item.accountId} ·{' '}
                      {formatBytes(item.totalBytes)} · {formatDate(item.updatedAt)}
                    </div>
                  </div>
                </div>
                <div className='flex items-center gap-2 pl-11 md:pl-0'>
                  <Button
                    as='a'
                    href={api.downloadFileUrl(item.id)}
                    download={item.remoteName}
                    size='sm'
                    radius='full'
                    color='primary'
                    variant='flat'
                    startContent={<MdDownload size={17} />}
                  >
                    下载到本机
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
