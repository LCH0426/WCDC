import { Button } from '@heroui/button';
import { Chip } from '@heroui/chip';
import { Input } from '@heroui/input';
import { Spinner } from '@heroui/spinner';
import { Switch } from '@heroui/switch';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import {
  MdDeleteOutline,
  MdOutlineRefresh,
  MdSearch,
  MdTerminal,
} from 'react-icons/md';
import toast from 'react-hot-toast';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { api } from '@/lib/api';
import type { LogEntry } from '@/lib/types';

const levels = ['', 'ERROR', 'WARN', 'INFO', 'DEBUG'] as const;

function levelColor(level: string): 'danger' | 'warning' | 'primary' | 'default' {
  switch (level.toUpperCase()) {
    case 'ERROR':
      return 'danger';
    case 'WARN':
      return 'warning';
    case 'INFO':
      return 'primary';
    default:
      return 'default';
  }
}

function formatLogTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export default function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.logs({
        limit: 500,
        level: level || undefined,
        contains: search.trim() || undefined,
      });
      setEntries(result.entries);
      setTotal(result.total);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取日志失败');
    } finally {
      setLoading(false);
    }
  }, [level, search]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  const clear = async () => {
    try {
      await api.clearLogs();
      toast.success('日志缓冲已清空');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '清空失败');
    }
  };

  return (
    <div className='animate-float-in space-y-4'>
      <div className='glass-card overflow-hidden'>
        <div className='flex flex-wrap items-center gap-3 border-b border-slate-200/60 px-5 py-4 dark:border-white/[0.06]'>
          <span className='flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary'>
            <MdTerminal size={24} />
          </span>
          <div className='min-w-0 flex-1'>
            <div className='text-base font-semibold text-slate-900 dark:text-white'>系统日志</div>
            <div className='text-xs text-slate-500 dark:text-slate-400'>
              共 {total} 条，保留最近 3000 条在内存中，并写入数据目录的 server.log
            </div>
          </div>
          <div className='flex items-center gap-2'>
            <Switch
              size='sm'
              isSelected={autoRefresh}
              onValueChange={setAutoRefresh}
            >
              自动刷新
            </Switch>
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
              size='sm'
              radius='full'
              variant='flat'
              className='text-danger'
              startContent={<MdDeleteOutline size={16} />}
              onPress={() => setClearOpen(true)}
            >
              清空
            </Button>
          </div>
        </div>

        <div className='flex flex-wrap items-center gap-2 px-4 py-3'>
          <div className='flex flex-wrap gap-1.5'>
            {levels.map((item) => (
              <button
                key={item || 'all'}
                type='button'
                onClick={() => setLevel(item)}
                className={clsx(
                  'rounded-full px-3 py-1.5 text-xs transition',
                  level === item
                    ? 'bg-primary text-white shadow-sm'
                    : 'bg-default-100 text-slate-500 hover:bg-default-200 dark:bg-white/[0.06] dark:text-slate-300'
                )}
              >
                {item || '全部'}
              </button>
            ))}
          </div>
          <Input
            size='sm'
            radius='full'
            className='ml-auto w-full sm:w-64'
            placeholder='搜索内容或模块'
            value={search}
            onValueChange={setSearch}
            startContent={<MdSearch size={16} className='text-slate-400' />}
            classNames={{ inputWrapper: 'bg-white/60 dark:bg-white/[0.04]' }}
          />
        </div>
      </div>

      <div className='glass-card overflow-hidden'>
        {loading && entries.length === 0 ? (
          <div className='flex h-[320px] items-center justify-center'>
            <Spinner color='primary' label='正在读取日志…' />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            title='没有匹配的日志'
            description='调整级别或搜索条件；产生新的操作后日志会出现在这里。'
          />
        ) : (
          <div className='divide-y divide-slate-200/60 font-mono text-xs dark:divide-white/[0.05]'>
            {entries.map((entry, index) => (
              <div
                key={`${entry.timestamp}-${index}`}
                className='flex flex-col gap-1 px-4 py-2.5 transition hover:bg-white/40 dark:hover:bg-white/[0.025] md:flex-row md:items-start md:gap-3'
              >
                <span className='shrink-0 text-[10px] text-slate-400 md:w-[168px]'>
                  {formatLogTime(entry.timestamp)}
                </span>
                <span className='shrink-0 md:w-16'>
                  <Chip
                    size='sm'
                    variant='flat'
                    color={levelColor(entry.level)}
                    className='h-5 px-1.5 text-[10px] font-semibold'
                  >
                    {entry.level}
                  </Chip>
                </span>
                <span className='min-w-0 flex-1 break-all text-slate-700 dark:text-slate-200'>
                  {entry.message}
                </span>
                <span className='shrink-0 text-[10px] text-slate-400 md:max-w-[240px] md:truncate'>
                  {entry.target}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title='清空日志'
        description='只会清空内存中的日志列表，不会删除服务器上的 server.log 文件。'
        confirmLabel='清空'
        danger
        onConfirm={clear}
      />
    </div>
  );
}
