import { Button } from '@heroui/button';
import { Input } from '@heroui/input';
import { Spinner } from '@heroui/spinner';
import { Tooltip } from '@heroui/tooltip';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MdArrowDownward,
  MdArrowUpward,
  MdCreateNewFolder,
  MdFolder,
  MdHome,
  MdRefresh,
  MdStorage,
} from 'react-icons/md';
import toast from 'react-hot-toast';

import { EmptyState } from '@/components/EmptyState';
import { FileIcon } from '@/components/FileIcon';
import { api } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import type { FileBrowseResult, StorageRoot } from '@/lib/types';

export default function ServerFilesPage() {
  const [roots, setRoots] = useState<StorageRoot[]>([]);
  const [home, setHome] = useState('');
  const [result, setResult] = useState<FileBrowseResult | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);

  const navigate = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const next = await api.serverFiles(path);
      setResult(next);
      setPathInput(next.path);
      setNewFolderOpen(false);
      setNewFolderName('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法读取目录');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api.storageRoots();
        if (cancelled) return;
        setRoots(info.roots);
        setHome(info.home);
        const start = info.home || info.roots[0]?.path;
        if (start) await navigate(start);
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : '无法读取磁盘列表');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const activeRoot = useMemo(() => {
    if (!result) return null;
    const inside = (path: string, root: string) => {
      if (path === root) return true;
      const separator = root.includes('\\') ? '\\' : '/';
      return path.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);
    };
    return roots
      .filter((root) => inside(result.path, root.path))
      .sort((left, right) => right.path.length - left.path.length)[0]?.path ?? null;
  }, [result, roots]);

  const handleCreateFolder = async () => {
    if (!result) return;
    const name = newFolderName.trim();
    if (!name) {
      toast.error('请输入文件夹名称');
      return;
    }
    setCreating(true);
    try {
      const created = await api.mkdirStorage(result.path, name);
      toast.success('文件夹已创建');
      await navigate(created.path);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建文件夹失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className='animate-float-in space-y-4'>
      <div className='glass-card overflow-hidden'>
        <div className='flex flex-wrap items-center gap-3 border-b border-slate-200/60 px-5 py-4 dark:border-white/[0.06]'>
          <span className='flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary'>
            <MdStorage size={24} />
          </span>
          <div className='min-w-0 flex-1'>
            <div className='text-base font-semibold text-slate-900 dark:text-white'>
              服务器文件
            </div>
            <div className='text-xs text-slate-500 dark:text-slate-400'>
              浏览和下载服务端磁盘上的任意文件；下载走浏览器，不经过夸克
            </div>
          </div>
          <Button
            size='sm'
            radius='full'
            variant='flat'
            startContent={<MdCreateNewFolder size={16} />}
            isDisabled={!result?.writable}
            onPress={() => setNewFolderOpen((value) => !value)}
          >
            新建文件夹
          </Button>
        </div>

        <div className='grid gap-3 p-3 md:grid-cols-[200px_1fr] md:p-4'>
          <div className='space-y-1.5'>
            <div className='px-1 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
              磁盘 / 挂载点
            </div>
            <button
              type='button'
              onClick={() => void navigate(home)}
              className={clsx(
                'flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm transition',
                result?.path === home
                  ? 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary-300'
                  : 'text-slate-600 hover:bg-default-100 dark:text-slate-300 dark:hover:bg-white/[0.05]'
              )}
            >
              <MdHome size={18} />
              <span className='min-w-0 flex-1 truncate'>主目录</span>
            </button>
            <div className='max-h-[420px] space-y-1 overflow-y-auto'>
              {roots.map((root) => {
                const active = activeRoot === root.path;
                return (
                  <button
                    key={root.path}
                    type='button'
                    onClick={() => void navigate(root.path)}
                    className={clsx(
                      'flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition',
                      active
                        ? 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary-300'
                        : 'text-slate-600 hover:bg-default-100 dark:text-slate-300 dark:hover:bg-white/[0.05]'
                    )}
                  >
                    <MdStorage size={18} className='shrink-0' />
                    <span className='min-w-0 flex-1'>
                      <span className='block truncate text-sm'>{root.name}</span>
                      <span className='block truncate text-[10px] text-slate-400'>
                        {formatBytes(root.freeBytes)} 可用
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className='min-w-0'>
            <div className='flex items-center gap-1.5'>
              <Tooltip content='上一级'>
                <Button
                  isIconOnly
                  size='sm'
                  radius='full'
                  variant='flat'
                  isDisabled={!result?.parent || loading}
                  onPress={() => result?.parent && void navigate(result.parent)}
                  aria-label='上一级'
                >
                  <MdArrowUpward size={18} />
                </Button>
              </Tooltip>
              <Input
                size='sm'
                radius='lg'
                value={pathInput}
                onValueChange={setPathInput}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void navigate(pathInput);
                }}
                placeholder='输入绝对路径后回车'
                classNames={{ inputWrapper: 'bg-white/60 dark:bg-white/[0.04]' }}
              />
              <Button
                size='sm'
                radius='full'
                variant='flat'
                onPress={() => void navigate(pathInput)}
                isDisabled={!pathInput.trim() || loading}
              >
                前往
              </Button>
              <Button
                isIconOnly
                size='sm'
                radius='full'
                variant='light'
                onPress={() => result && void navigate(result.path)}
                aria-label='刷新'
                isDisabled={!result || loading}
              >
                <MdRefresh size={18} />
              </Button>
            </div>

            <div className='mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400'>
              {result && (
                <>
                  <span>剩余 {formatBytes(result.freeBytes)}</span>
                  <span>共 {formatBytes(result.totalBytes)}</span>
                  <span
                    className={clsx(
                      'rounded-md px-1.5 py-0.5',
                      result.writable
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                    )}
                  >
                    {result.writable ? '可写' : '只读'}
                  </span>
                </>
              )}
            </div>

            {newFolderOpen && result && (
              <div className='mt-2 flex items-center gap-2 rounded-xl bg-slate-100/70 p-2 dark:bg-white/[0.05]'>
                <Input
                  autoFocus
                  size='sm'
                  radius='lg'
                  placeholder='新文件夹名称'
                  value={newFolderName}
                  onValueChange={setNewFolderName}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleCreateFolder();
                  }}
                />
                <Button
                  size='sm'
                  radius='full'
                  color='primary'
                  isLoading={creating}
                  onPress={() => void handleCreateFolder()}
                >
                  创建
                </Button>
              </div>
            )}

            <div className='mt-2 min-h-[360px] rounded-2xl border border-slate-200/70 p-1.5 dark:border-white/[0.06]'>
              {loading ? (
                <div className='flex h-[340px] items-center justify-center'>
                  <Spinner color='primary' />
                </div>
              ) : result && result.entries.length > 0 ? (
                <div>
                  <div className='grid grid-cols-[1fr_90px_120px_90px] items-center gap-3 border-b border-slate-200/60 px-3 pb-2 text-[11px] text-slate-400 dark:border-white/[0.06] md:grid-cols-[1fr_110px_170px_100px]'>
                    <span>名称</span>
                    <span>大小</span>
                    <span>修改时间</span>
                    <span className='text-right'>操作</span>
                  </div>
                  <div className='mt-1 space-y-0.5'>
                    {result.entries.map((entry) => (
                      <div
                        key={entry.path}
                        className='file-row grid-cols-[1fr_90px_120px_90px] md:grid-cols-[1fr_110px_170px_100px]'
                      >
                        <button
                          type='button'
                          className='flex min-w-0 items-center gap-3 text-left'
                          onClick={() => {
                            if (entry.isDir) void navigate(entry.path);
                          }}
                        >
                          {entry.isDir ? (
                            <span className='flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-amber-400/15 text-amber-500'>
                              <MdFolder size={21} />
                            </span>
                          ) : (
                            <FileIcon name={entry.name} isDir={false} size='sm' />
                          )}
                          <span className='truncate text-sm font-medium text-slate-800 dark:text-slate-100'>
                            {entry.name}
                          </span>
                        </button>
                        <span className='truncate text-xs text-slate-500 dark:text-slate-400'>
                          {entry.isDir ? '—' : formatBytes(entry.size)}
                        </span>
                        <span className='truncate text-xs text-slate-500 dark:text-slate-400'>
                          {formatDate(entry.modifiedAt)}
                        </span>
                        <span className='text-right'>
                          {entry.isDir ? (
                            <Button
                              size='sm'
                              radius='full'
                              variant='light'
                              onPress={() => void navigate(entry.path)}
                            >
                              打开
                            </Button>
                          ) : (
                            <Button
                              as='a'
                              href={api.serverFileUrl(entry.path)}
                              download={entry.name}
                              size='sm'
                              radius='full'
                              color='primary'
                              variant='flat'
                              startContent={<MdArrowDownward size={16} />}
                            >
                              下载
                            </Button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <EmptyState title='这个文件夹是空的' description='没有可下载的文件。' />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
