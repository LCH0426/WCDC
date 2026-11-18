import { Button } from '@heroui/button';
import { Chip } from '@heroui/chip';
import { Tooltip } from '@heroui/tooltip';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import {
  MdArrowForward,
  MdDeleteOutline,
  MdDownload,
  MdOutlinePause,
  MdOutlinePlayArrow,
  MdOutlineRefresh,
  MdOutlineStop,
} from 'react-icons/md';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';

import { EmptyState } from '@/components/EmptyState';
import { FileIcon } from '@/components/FileIcon';
import { useApp } from '@/context/app';
import { api } from '@/lib/api';
import {
  formatBytes,
  formatDate,
  formatSpeed,
  transferPercent,
  transferStatusColor,
  transferStatusLabel,
} from '@/lib/format';
import type { TransferView } from '@/lib/types';

type TabKey = 'all' | 'active' | 'done';

const tabs: { key: TabKey; label: string }[] = [
  { key: 'all', label: '全部任务' },
  { key: 'active', label: '进行中' },
  { key: 'done', label: '已完成' },
];

function isActive(transfer: TransferView) {
  return ['queued', 'running', 'paused'].includes(transfer.status);
}

export default function TransfersPage() {
  const { transfers, refreshTransfers } = useApp();
  const [tab, setTab] = useState<TabKey>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (tab === 'active') return transfers.filter(isActive);
    if (tab === 'done') return transfers.filter((item) => item.status === 'done');
    return transfers;
  }, [transfers, tab]);

  const active = transfers.filter((item) => item.status === 'running');
  const totalSpeed = active.reduce((sum, item) => sum + (item.speedBps || 0), 0);
  const finished = transfers.filter((item) => item.status === 'done').length;
  const failed = transfers.filter((item) => item.status === 'error').length;

  const run = async (id: string, action: 'pause' | 'resume' | 'retry' | 'cancel') => {
    setBusyId(id);
    try {
      await api.transferAction(id, action);
      const labels = { pause: '已暂停', resume: '已继续', retry: '已重试', cancel: '已取消' };
      toast.success(labels[action]);
      await refreshTransfers();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await api.removeTransfer(id);
      toast.success('已移除任务记录');
      await refreshTransfers();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移除失败');
    } finally {
      setBusyId(null);
    }
  };

  const clearFinished = async () => {
    try {
      await api.clearTransfers();
      toast.success('已清理完成任务');
      await refreshTransfers();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '清理失败');
    }
  };

  return (
    <div className='animate-float-in space-y-4'>
      <div className='grid gap-3 sm:grid-cols-3'>
        <div className='glass-card flex items-center gap-4 p-4'>
          <div className='flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-500/12 text-primary-500'>
            <MdDownload size={24} />
          </div>
          <div>
            <div className='text-2xl font-semibold text-slate-900 dark:text-white'>
              {active.length}
            </div>
            <div className='text-xs text-slate-500 dark:text-slate-400'>正在下载</div>
          </div>
          <div className='ml-auto text-right'>
            <div className='text-sm font-semibold text-primary-500'>{formatSpeed(totalSpeed)}</div>
            <div className='text-[11px] text-slate-400'>总速度</div>
          </div>
        </div>
        <div className='glass-card flex items-center gap-4 p-4'>
          <div className='flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-500'>
            <MdOutlinePlayArrow size={24} />
          </div>
          <div>
            <div className='text-2xl font-semibold text-slate-900 dark:text-white'>{finished}</div>
            <div className='text-xs text-slate-500 dark:text-slate-400'>已完成</div>
          </div>
        </div>
        <div className='glass-card flex items-center gap-4 p-4'>
          <div className='flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-500/12 text-rose-500'>
            <MdOutlineStop size={24} />
          </div>
          <div>
            <div className='text-2xl font-semibold text-slate-900 dark:text-white'>{failed}</div>
            <div className='text-xs text-slate-500 dark:text-slate-400'>失败任务</div>
          </div>
        </div>
      </div>

      <div className='glass-card overflow-hidden'>
        <div className='flex flex-wrap items-center gap-2 border-b border-slate-200/70 px-4 py-3 dark:border-white/[0.07]'>
          <div className='flex rounded-2xl bg-slate-100/80 p-1 dark:bg-white/[0.05]'>
            {tabs.map((item) => (
              <button
                key={item.key}
                type='button'
                onClick={() => setTab(item.key)}
                className={clsx(
                  'rounded-xl px-3.5 py-1.5 text-sm transition',
                  tab === item.key
                    ? 'bg-white font-medium text-primary-600 shadow-sm dark:bg-white/[0.1] dark:text-primary-300'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className='ml-auto flex items-center gap-2'>
            <Tooltip content='刷新任务列表'>
              <Button isIconOnly size='sm' variant='light' onPress={() => void refreshTransfers()}>
                <MdOutlineRefresh size={18} />
              </Button>
            </Tooltip>
            <Button
              size='sm'
              variant='flat'
              startContent={<MdDeleteOutline size={16} />}
              onPress={() => void clearFinished()}
            >
              清理记录
            </Button>
            <Button
              as={Link}
              to='/quark'
              size='sm'
              color='primary'
              variant='flat'
              endContent={<MdArrowForward size={16} />}
            >
              去下载文件
            </Button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            title={tab === 'active' ? '没有进行中的任务' : '还没有下载任务'}
            description='在「全部文件」中选中文件或文件夹，点击下载并选择服务器存储盘。'
            action={
              <Button as={Link} to='/quark' color='primary' size='sm'>
                浏览我的文件
              </Button>
            }
          />
        ) : (
          <div className='divide-y divide-slate-200/60 dark:divide-white/[0.06]'>
            {filtered.map((transfer) => {
              const percent = transferPercent(transfer);
              const busy = busyId === transfer.id;
              return (
                <div key={transfer.id} className='flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-center'>
                  <div className='flex min-w-0 flex-1 items-center gap-3'>
                    <FileIcon name={transfer.remoteName} isDir={false} size='sm' />
                    <div className='min-w-0 flex-1'>
                      <div className='flex items-center gap-2'>
                        <span className='truncate text-sm font-medium text-slate-800 dark:text-slate-100'>
                          {transfer.remoteName}
                        </span>
                        <Chip
                          size='sm'
                          variant='flat'
                          color={transferStatusColor(transfer)}
                          className='h-5 shrink-0 text-[10px]'
                        >
                          {transferStatusLabel(transfer)}
                        </Chip>
                      </div>
                      <div className='mt-0.5 flex items-center gap-2 text-[11px] text-slate-400'>
                        <span className='truncate font-mono' title={transfer.localPath}>
                          {transfer.localPath}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className='flex items-center gap-4 md:w-[380px]'>
                    <div className='min-w-0 flex-1'>
                      <div className='h-1.5 overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/[0.08]'>
                        <div
                          className={clsx(
                            'h-full rounded-full transition-all',
                            transfer.status === 'error'
                              ? 'bg-rose-500'
                              : transfer.status === 'done'
                                ? 'bg-emerald-500'
                                : 'bg-gradient-to-r from-primary-400 to-indigo-500'
                          )}
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <div className='mt-1 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400'>
                        <span>
                          {formatBytes(transfer.doneBytes)} / {formatBytes(transfer.totalBytes)}
                        </span>
                        <span>
                          {transfer.status === 'running'
                            ? formatSpeed(transfer.speedBps)
                            : `${percent.toFixed(0)}%`}
                        </span>
                      </div>
                      <div className='mt-0.5 text-[10px] text-slate-400'>
                        {formatDate(transfer.createdAt)}
                        {transfer.errorMessage ? ` · ${transfer.errorMessage}` : ''}
                      </div>
                    </div>

                    <div className='flex items-center gap-1'>
                      {(transfer.status === 'running' || transfer.status === 'queued') && (
                        <Tooltip content='暂停'>
                          <Button
                            isIconOnly
                            size='sm'
                            variant='light'
                            isLoading={busy}
                            onPress={() => void run(transfer.id, 'pause')}
                          >
                            <MdOutlinePause size={19} />
                          </Button>
                        </Tooltip>
                      )}
                      {transfer.status === 'paused' && (
                        <Tooltip content='继续'>
                          <Button
                            isIconOnly
                            size='sm'
                            variant='light'
                            isLoading={busy}
                            onPress={() => void run(transfer.id, 'resume')}
                          >
                            <MdOutlinePlayArrow size={19} />
                          </Button>
                        </Tooltip>
                      )}
                      {transfer.status === 'error' && (
                        <Tooltip content='重试'>
                          <Button
                            isIconOnly
                            size='sm'
                            variant='light'
                            isLoading={busy}
                            onPress={() => void run(transfer.id, 'retry')}
                          >
                            <MdOutlineRefresh size={18} />
                          </Button>
                        </Tooltip>
                      )}
                      {['done', 'canceled', 'error'].includes(transfer.status) && (
                        <Tooltip content='移除记录'>
                          <Button
                            isIconOnly
                            size='sm'
                            variant='light'
                            className='text-danger'
                            isLoading={busy}
                            onPress={() => void remove(transfer.id)}
                          >
                            <MdDeleteOutline size={18} />
                          </Button>
                        </Tooltip>
                      )}
                      {isActive(transfer) && (
                        <Tooltip content='取消'>
                          <Button
                            isIconOnly
                            size='sm'
                            variant='light'
                            className='text-danger'
                            isLoading={busy}
                            onPress={() => void run(transfer.id, 'cancel')}
                          >
                            <MdOutlineStop size={18} />
                          </Button>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
