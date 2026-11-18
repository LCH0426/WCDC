import { Button } from '@heroui/button';
import { Input } from '@heroui/input';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/modal';
import { Spinner } from '@heroui/spinner';
import { Tooltip } from '@heroui/tooltip';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MdArrowUpward,
  MdCreateNewFolder,
  MdFolder,
  MdHome,
  MdRefresh,
  MdStorage,
} from 'react-icons/md';
import toast from 'react-hot-toast';

import { useApp } from '@/context/app';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import type { BrowseResult, StorageRoot } from '@/lib/types';

export function StorageBrowser({
  open,
  onClose,
  initialPath,
  onSelect,
  title = '选择服务器文件夹',
  confirmLabel = '选择此文件夹',
}: {
  open: boolean;
  onClose: () => void;
  initialPath?: string;
  onSelect: (path: string) => void;
  title?: string;
  confirmLabel?: string;
}) {
  const [roots, setRoots] = useState<StorageRoot[]>([]);
  const [home, setHome] = useState('');
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const { settings } = useApp();
  const fnosMode = settings?.fnosMode === true;

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

  const navigate = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const next = await api.browseStorage(path);
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
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await api.storageRoots();
        if (cancelled) return;
        setRoots(info.roots);
        setHome(info.home);
        const start = initialPath?.trim() || info.home || info.roots[0]?.path;
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
  }, [open, initialPath, navigate]);

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
    <Modal isOpen={open} onClose={onClose} size='4xl' backdrop='blur' scrollBehavior='inside'>
      <ModalContent>
        <ModalHeader className='flex flex-col gap-1'>
          <span className='text-lg'>{title}</span>
          <span className='text-xs font-normal text-slate-500 dark:text-slate-400'>
            {fnosMode
              ? '只显示飞牛应用设置中已授权的文件夹'
              : '可直接浏览服务器上的所有磁盘目录；下载文件会写入这里'}
          </span>
        </ModalHeader>
        <ModalBody>
          <div className='grid gap-3 md:grid-cols-[200px_1fr]'>
            <div className='space-y-1.5'>
              <div className='px-1 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
                {fnosMode ? '授权文件夹' : '磁盘 / 挂载点'}
              </div>
              <button
                type='button'
                onClick={() => void navigate(home)}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm transition',
                  result?.path === home
                    ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/[0.05]'
                )}
              >
                <MdHome size={18} />
                <span className='min-w-0 flex-1 truncate'>{fnosMode ? '授权目录' : '主目录'}</span>
              </button>
              <div className='max-h-[330px] space-y-1 overflow-y-auto'>
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
                          ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300'
                          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/[0.05]'
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
                {roots.length === 0 && (
                  <div className='px-2 py-4 text-xs text-slate-400'>没有找到磁盘</div>
                )}
              </div>
            </div>

            <div className='min-w-0'>
              <div className='flex items-center gap-1.5'>
                <Tooltip content='上一级'>
                  <Button
                    isIconOnly
                    size='sm'
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
                  value={pathInput}
                  onValueChange={setPathInput}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void navigate(pathInput);
                  }}
                  placeholder='输入绝对路径后回车'
                  classNames={{ inputWrapper: 'bg-white/70 dark:bg-white/[0.04]' }}
                />
                <Button
                  size='sm'
                  variant='flat'
                  onPress={() => void navigate(pathInput)}
                  isDisabled={!pathInput.trim() || loading}
                >
                  前往
                </Button>
                <Button
                  isIconOnly
                  size='sm'
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
                      {result.writable ? '可写' : '不可写'}
                    </span>
                  </>
                )}
                <Button
                  size='sm'
                  variant='flat'
                  className='ml-auto'
                  startContent={<MdCreateNewFolder size={16} />}
                  isDisabled={!result?.writable}
                  onPress={() => setNewFolderOpen((value) => !value)}
                >
                  新建文件夹
                </Button>
              </div>

              {newFolderOpen && result && (
                <div className='mt-2 flex items-center gap-2 rounded-xl bg-slate-100/80 p-2 dark:bg-white/[0.05]'>
                  <Input
                    autoFocus
                    size='sm'
                    placeholder='新文件夹名称'
                    value={newFolderName}
                    onValueChange={setNewFolderName}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleCreateFolder();
                    }}
                  />
                  <Button
                    size='sm'
                    color='primary'
                    isLoading={creating}
                    onPress={() => void handleCreateFolder()}
                  >
                    创建
                  </Button>
                </div>
              )}

              <div className='mt-2 h-[320px] overflow-y-auto rounded-2xl border border-slate-200/80 p-1.5 dark:border-white/[0.06]'>
                {loading ? (
                  <div className='flex h-full items-center justify-center'>
                    <Spinner color='primary' />
                  </div>
                ) : result && result.entries.length > 0 ? (
                  result.entries.map((entry) => (
                    <button
                      key={entry.path}
                      type='button'
                      onClick={() => void navigate(entry.path)}
                      className='file-row w-full grid-cols-[40px_1fr_24px] text-left'
                    >
                      <span className='flex h-9 w-9 items-center justify-center rounded-xl bg-amber-400/15 text-amber-500'>
                        <MdFolder size={21} />
                      </span>
                      <span className='truncate text-sm text-slate-700 dark:text-slate-200'>
                        {entry.name}
                      </span>
                      <span className='text-right text-slate-300'>›</span>
                    </button>
                  ))
                ) : (
                  <div className='flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-400'>
                    <MdFolder size={28} />
                    没有子文件夹
                  </div>
                )}
              </div>
            </div>
          </div>
        </ModalBody>
        <ModalFooter className='flex-wrap gap-2'>
          <div className='mr-auto min-w-0 text-[11px] text-slate-500 dark:text-slate-400'>
            <span className='text-slate-400'>当前：</span>
            <span className='break-all font-mono'>{result?.path ?? '—'}</span>
          </div>
          <Button variant='light' onPress={onClose}>
            取消
          </Button>
          <Button
            color='primary'
            isDisabled={!result?.writable || loading}
            onPress={() => {
              if (!result) return;
              onSelect(result.path);
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
