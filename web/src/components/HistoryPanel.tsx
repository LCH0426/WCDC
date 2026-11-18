import { Button } from '@heroui/button';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import {
  MdDeleteOutline,
  MdExpandMore,
  MdHistory,
  MdImage,
  MdMovieFilter,
  MdRefresh,
} from 'react-icons/md';
import toast from 'react-hot-toast';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import type { HistoryItem, HistoryRecord } from '@/lib/types';

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

function itemStatusLabel(status: string): { label: string; className: string } {
  switch (status) {
    case 'done':
      return { label: '完成', className: 'text-success' };
    case 'failed':
      return { label: '失败', className: 'text-danger' };
    case 'canceled':
      return { label: '取消', className: 'text-default-500' };
    case 'running':
      return { label: '进行中', className: 'text-primary' };
    case 'queued':
      return { label: '排队', className: 'text-secondary-600' };
    default:
      return { label: status, className: 'text-default-500' };
  }
}

function HistoryItemRow({ item }: { item: HistoryItem }) {
  const chip = itemStatusLabel(item.status);
  const saved = item.sourceBytes - item.outputBytes;
  return (
    <div className='flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-white/35 px-3 py-2 text-[11px] dark:bg-white/[0.03]'>
      <span className='min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200' title={item.outputPath}>
        {item.name}
      </span>
      <span className={clsx('shrink-0 font-medium', chip.className)}>{chip.label}</span>
      <span className='shrink-0 text-slate-500 dark:text-slate-400'>
        {formatBytes(item.sourceBytes)} → {formatBytes(item.outputBytes)}
        {item.status === 'done' && item.sourceBytes > 0 && (
          <span
            className={clsx(
              'ml-1',
              saved >= 0 ? 'text-success' : 'text-warning'
            )}
          >
            {saved >= 0 ? '省 ' : '增 '}
            {formatBytes(Math.abs(saved))}
          </span>
        )}
      </span>
      {item.durationMs > 0 && (
        <span className='shrink-0 text-slate-400'>{formatDuration(item.durationMs)}</span>
      )}
      {item.error && (
        <span className='w-full break-words text-danger'>{item.error}</span>
      )}
    </div>
  );
}

function HistoryCard({
  record,
  expanded,
  onToggle,
}: {
  record: HistoryRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  const video = record.kind === 'video';
  const saved = record.savedBytes;
  return (
    <div className='glass-card overflow-hidden'>
      <div className='flex flex-wrap items-start gap-3 p-4'>
        <div
          className={clsx(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
            video
              ? 'bg-primary/10 text-primary'
              : 'bg-secondary/15 text-secondary-700 dark:text-secondary-300'
          )}
        >
          {video ? <MdMovieFilter size={22} /> : <MdImage size={22} />}
        </div>
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-sm font-semibold text-slate-800 dark:text-slate-100'>
              {video ? '视频转码' : '图片转换'}
            </span>
            <span className='rounded-full bg-default-100 px-2 py-0.5 text-[10px] text-default-600 dark:bg-white/[0.06] dark:text-default-300'>
              {record.summary}
            </span>
          </div>
          <div className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400'>
            <span>{new Date(record.finishedAt).toLocaleString()}</span>
            <span>
              {record.total} 个{record.done > 0 ? `，成功 ${record.done}` : ''}
              {record.failed > 0 ? ` · 失败 ${record.failed}` : ''}
              {record.canceled > 0 ? ` · 取消 ${record.canceled}` : ''}
            </span>
            <span className='font-medium text-slate-600 dark:text-slate-300'>
              用时 {formatDuration(record.durationMs)}
            </span>
          </div>
          {record.sourceBytes > 0 && (
            <div className='mt-1 text-[11px] text-slate-500 dark:text-slate-400'>
              总大小 {formatBytes(record.sourceBytes)} → {formatBytes(record.outputBytes)}
              {record.savedPercent != null && (
                <span
                  className={clsx(
                    'ml-1 font-medium',
                    saved >= 0 ? 'text-success' : 'text-warning'
                  )}
                >
                  {Math.abs(record.savedPercent) < 0.05
                    ? '基本不变'
                    : `${saved >= 0 ? '节省' : '增大'} ${formatBytes(Math.abs(saved))}（${Math.abs(
                        record.savedPercent
                      ).toFixed(1)}%）`}
                </span>
              )}
            </div>
          )}
        </div>
        <Button
          size='sm'
          variant='light'
          isIconOnly
          aria-label={expanded ? '收起明细' : '展开明细'}
          title={expanded ? '收起明细' : '展开明细'}
          onPress={onToggle}
        >
          <MdExpandMore
            size={19}
            className={clsx('text-slate-400 transition', expanded && 'rotate-180')}
          />
        </Button>
      </div>
      {expanded && (
        <div className='space-y-1.5 border-t border-slate-200/60 p-3 dark:border-white/[0.06]'>
          {record.items.length === 0 ? (
            <div className='px-2 text-[11px] text-slate-400'>没有明细记录</div>
          ) : (
            record.items.map((item, index) => (
              <HistoryItemRow key={`${item.name}-${index}`} item={item} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function HistoryPanel() {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [clearOpen, setClearOpen] = useState(false);

  const load = useCallback(async (manual = false) => {
    if (manual) setLoading(true);
    try {
      setRecords(await api.history(200));
    } catch (error) {
      if (manual) {
        toast.error(error instanceof Error ? error.message : '读取归档日志失败');
      }
    } finally {
      if (manual) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, [load]);

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clear = async () => {
    try {
      const result = await api.clearHistory();
      setRecords([]);
      toast.success(`已清理 ${result.removed} 条归档`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '清空失败');
    }
  };

  return (
    <div className='space-y-3'>
      <div className='glass-card flex flex-wrap items-center justify-between gap-2 p-4'>
        <div>
          <div className='flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100'>
            <MdHistory className='text-primary' size={19} />
            转换归档
          </div>
          <div className='mt-0.5 text-[11px] text-slate-500 dark:text-slate-400'>
            每次批量转码/图片转换完成后自动记录数量、耗时、大小变化和逐文件结果。
          </div>
        </div>
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            variant='flat'
            isLoading={loading}
            onPress={() => void load(true)}
            startContent={<MdRefresh size={16} />}
          >
            刷新
          </Button>
          <Button
            size='sm'
            variant='flat'
            color='danger'
            isDisabled={records.length === 0}
            onPress={() => setClearOpen(true)}
            startContent={<MdDeleteOutline size={16} />}
          >
            清空
          </Button>
        </div>
      </div>

      {records.length === 0 ? (
        <div className='glass-card p-6 text-center text-sm text-slate-500 dark:text-slate-400'>
          还没有归档记录。完成一批视频转码或图片转换后，这里会显示本次处理的总数、耗时和节省空间。
        </div>
      ) : (
        <div className='space-y-2'>
          {records.map((record) => (
            <HistoryCard
              key={record.id}
              record={record}
              expanded={expanded.has(record.id)}
              onToggle={() => toggle(record.id)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title='清空转换归档'
        description='只会删除归档记录，不会删除已经转码或转换完成的文件。此操作不可恢复。'
        confirmLabel='清空'
        danger
        onConfirm={() => void clear()}
      />
    </div>
  );
}
