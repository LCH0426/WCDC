import { Button } from '@heroui/button';
import { Checkbox } from '@heroui/checkbox';
import { Spinner } from '@heroui/spinner';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MdDeleteForever,
  MdOutlineRefresh,
  MdRestoreFromTrash,
} from 'react-icons/md';
import toast from 'react-hot-toast';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { FileIcon } from '@/components/FileIcon';
import { useApp } from '@/context/app';
import { api } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import type { RecycleView } from '@/lib/types';

export default function RecycleBinPage() {
  const { activeAccountId } = useApp();
  const [entries, setEntries] = useState<RecycleView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<'delete' | 'clear' | null>(null);

  const handleError = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
    },
    []
  );

  const load = useCallback(
    async (pageNumber = 1, append = false) => {
      if (!activeAccountId) return;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const result = await api.listRecycle(activeAccountId, pageNumber, 200);
        setEntries((current) => (append ? [...current, ...result.entries] : result.entries));
        setTotal(result.total);
        setPage(pageNumber);
        setSelected(new Set());
      } catch (error) {
        handleError(error);
        if (!append) setEntries([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [activeAccountId, handleError]
  );

  useEffect(() => {
    if (!activeAccountId) return;
    void load(1, false);
  }, [activeAccountId, load]);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entry.recordId)),
    [entries, selected]
  );
  const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.recordId));
  const someSelected = selected.size > 0 && !allSelected;

  const toggle = (recordId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((current) => {
      if (entries.every((entry) => current.has(entry.recordId))) return new Set();
      return new Set(entries.map((entry) => entry.recordId));
    });
  };

  const restore = async () => {
    if (!activeAccountId || selected.size === 0) return;
    try {
      await api.restoreRecycle(activeAccountId, [...selected]);
      toast.success(`已恢复 ${selected.size} 个项目`);
      await load(1, false);
    } catch (error) {
      handleError(error);
    }
  };

  const remove = async () => {
    if (!activeAccountId) return;
    try {
      await api.deleteRecycle(activeAccountId, [...selected]);
      toast.success(`已彻底删除 ${selected.size} 个项目`);
      setConfirm(null);
      await load(1, false);
    } catch (error) {
      handleError(error);
    }
  };

  const clear = async () => {
    if (!activeAccountId) return;
    const toastId = toast.loading('正在清空回收站…');
    try {
      const result = await api.clearRecycle(activeAccountId);
      toast.success(`回收站已清空（${result.removed} 项）`, { id: toastId });
      setConfirm(null);
      await load(1, false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '清空失败', { id: toastId });
    }
  };

  if (!activeAccountId) return null;

  return (
    <div className='animate-float-in space-y-4'>
      <div className='glass-card overflow-hidden'>
        <div className='flex flex-wrap items-center gap-2 border-b border-slate-200/70 px-4 py-3.5 dark:border-white/[0.07]'>
          <div>
            <div className='text-base font-semibold text-slate-900 dark:text-white'>回收站</div>
            <div className='text-xs text-slate-500 dark:text-slate-400'>
              共 {total} 项 · 删除的文件会先进入这里
            </div>
          </div>
          <div className='ml-auto flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              color='primary'
              variant='flat'
              startContent={<MdRestoreFromTrash size={17} />}
              isDisabled={selected.size === 0}
              onPress={() => void restore()}
            >
              恢复
            </Button>
            <Button
              size='sm'
              variant='flat'
              className='text-danger'
              startContent={<MdDeleteForever size={17} />}
              isDisabled={selected.size === 0}
              onPress={() => setConfirm('delete')}
            >
              彻底删除
            </Button>
            <Button
              size='sm'
              variant='light'
              className='text-slate-500'
              onPress={() => setConfirm('clear')}
            >
              清空回收站
            </Button>
            <Button
              isIconOnly
              size='sm'
              variant='light'
              onPress={() => void load(1, false)}
              aria-label='刷新'
            >
              <MdOutlineRefresh size={18} />
            </Button>
          </div>
        </div>

        <div className='grid grid-cols-[28px_1fr] items-center gap-3 border-b border-slate-200/60 px-4 py-2 text-[11px] text-slate-500 dark:border-white/[0.06] dark:text-slate-400 md:grid-cols-[28px_1fr_120px_170px]'>
          <Checkbox
            size='sm'
            aria-label='全选'
            isSelected={allSelected}
            isIndeterminate={someSelected}
            onValueChange={toggleAll}
          />
          <span className='whitespace-nowrap'>文件名</span>
          <span className='hidden md:block'>大小</span>
          <span className='hidden md:block'>删除时间</span>
        </div>

        {loading ? (
          <div className='flex h-[320px] items-center justify-center'>
            <Spinner color='primary' label='正在读取回收站…' />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState title='回收站是空的' description='删除的文件会在这里保留一段时间，可随时恢复。' />
        ) : (
          <div className='p-1.5'>
            {entries.map((entry) => {
              const isSelected = selected.has(entry.recordId);
              return (
                <div
                  key={entry.recordId}
                  role='button'
                  tabIndex={0}
                  onClick={() => toggle(entry.recordId)}
                  onKeyDown={(event) => {
                    if (event.key === ' ') {
                      event.preventDefault();
                      toggle(entry.recordId);
                    }
                  }}
                  className={clsx(
                    'file-row grid-cols-[28px_1fr] md:grid-cols-[28px_1fr_120px_170px]',
                    isSelected && 'file-row-selected'
                  )}
                >
                  <div onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      size='sm'
                      aria-label={`选择 ${entry.name}`}
                      isSelected={isSelected}
                      onValueChange={() => toggle(entry.recordId)}
                    />
                  </div>
                  <div className='flex min-w-0 items-center gap-3'>
                    <FileIcon name={entry.name} isDir={entry.isDir} size='sm' />
                    <div className='min-w-0'>
                      <div className='truncate text-sm font-medium text-slate-800 dark:text-slate-100'>
                        {entry.name}
                      </div>
                      <div className='whitespace-nowrap text-[11px] text-slate-400'>
                        {entry.isDir ? '文件夹' : entry.formatType || '文件'}
                      </div>
                    </div>
                  </div>
                  <div className='hidden text-xs text-slate-500 dark:text-slate-400 md:block'>
                    {entry.isDir ? '—' : formatBytes(entry.size)}
                  </div>
                  <div className='hidden text-xs text-slate-500 dark:text-slate-400 md:block'>
                    {formatDate(entry.deletedAt || entry.updatedAt)}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!loading && entries.length < total && (
          <div className='flex justify-center py-4'>
            <Button
              size='sm'
              variant='flat'
              isLoading={loadingMore}
              onPress={() => void load(page + 1, true)}
            >
              加载更多
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title='彻底删除'
        description={`确定彻底删除选中的 ${selected.size} 个项目吗？此操作无法恢复。`}
        confirmLabel='彻底删除'
        danger
        onConfirm={remove}
      />
      <ConfirmDialog
        open={confirm === 'clear'}
        onClose={() => setConfirm(null)}
        title='清空回收站'
        description='回收站中的所有文件都会被彻底删除，此操作无法恢复。'
        confirmLabel='清空'
        danger
        onConfirm={clear}
      />
    </div>
  );
}
