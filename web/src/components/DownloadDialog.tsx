import { Button } from '@heroui/button';
import { Checkbox } from '@heroui/checkbox';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/modal';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MdFolderOpen, MdOutlineFolder, MdStorage } from 'react-icons/md';
import toast from 'react-hot-toast';

import { StorageBrowser } from '@/components/StorageBrowser';
import { useApp } from '@/context/app';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import type { DownloadItem, StorageRoot } from '@/lib/types';

interface DestinationInfo {
  freeBytes: number;
  totalBytes: number;
  writable: boolean;
}

export function DownloadDialog({
  open,
  onClose,
  accountId,
  items,
  defaultDir,
  onEnqueued,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  items: DownloadItem[];
  defaultDir?: string;
  onEnqueued?: () => void;
}) {
  const { saveSettings, settings } = useApp();
  const [destDir, setDestDir] = useState('');
  const [setDefault, setSetDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [roots, setRoots] = useState<StorageRoot[]>([]);
  const [destination, setDestination] = useState<DestinationInfo | null>(null);

  useEffect(() => {
    if (!open) return;
    setDestDir(defaultDir?.trim() ?? '');
    setSetDefault(false);
    setBrowseOpen(false);
    void api
      .storageRoots()
      .then((info) => setRoots(info.roots))
      .catch(() => setRoots([]));
  }, [open, defaultDir]);

  const loadDestination = useCallback(async (path: string) => {
    if (!path.trim()) {
      setDestination(null);
      return;
    }
    try {
      const info = await api.browseStorage(path);
      setDestination({
        freeBytes: info.freeBytes,
        totalBytes: info.totalBytes,
        writable: info.writable,
      });
    } catch {
      setDestination(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadDestination(destDir);
  }, [open, destDir, loadDestination]);

  const totalSize = items.reduce((sum, item) => sum + (item.size ?? 0), 0);

  const handleSubmit = async () => {
    if (!destDir.trim()) {
      toast.error('请选择下载位置');
      return;
    }
    if (destination && !destination.writable) {
      toast.error('该目录不可写，请换一个文件夹');
      return;
    }
    setBusy(true);
    try {
      if (setDefault) {
        await saveSettings({ downloadDir: destDir.trim() });
      }
      const result = await api.enqueueDownload(accountId, destDir.trim(), items);
      toast.success(`已加入下载队列：${items.length} 个文件`);
      if (result.ids.length > 0) {
        toast.success('可在「传输中心」查看进度');
      }
      onEnqueued?.();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加入下载失败');
    } finally {
      setBusy(false);
    }
  };

  const quickRoots = useMemo(() => roots.slice(0, 8), [roots]);

  return (
    <>
      <Modal isOpen={open} onClose={onClose} size='2xl' backdrop='blur' scrollBehavior='inside'>
        <ModalContent>
          <ModalHeader className='flex flex-col gap-1'>
            <span className='text-lg'>选择下载位置</span>
            <span className='text-xs font-normal text-slate-500 dark:text-slate-400'>
              文件由服务端下载到这台机器的任意磁盘目录，不经过浏览器
            </span>
          </ModalHeader>
          <ModalBody className='gap-4'>
            <div>
              <div className='mb-2 text-xs font-medium text-slate-500 dark:text-slate-400'>
                目标文件夹
              </div>
              <div className='flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/70 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.04]'>
                <MdOutlineFolder className='shrink-0 text-amber-500' size={20} />
                <span className='min-w-0 flex-1 break-all font-mono text-xs text-slate-700 dark:text-slate-200'>
                  {destDir || '尚未选择'}
                </span>
                <Button
                  size='sm'
                  variant='flat'
                  startContent={<MdFolderOpen size={16} />}
                  onPress={() => setBrowseOpen(true)}
                >
                  {settings?.fnosMode ? '选择授权文件夹…' : '浏览所有磁盘…'}
                </Button>
              </div>
              <div className='mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400'>
                {destination ? (
                  <>
                    <span>剩余 {formatBytes(destination.freeBytes)}</span>
                    <span>共 {formatBytes(destination.totalBytes)}</span>
                    <span
                      className={clsx(
                        'rounded-md px-1.5 py-0.5',
                        destination.writable
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                      )}
                    >
                      {destination.writable ? '可写' : '不可写'}
                    </span>
                  </>
                ) : (
                  <span>选择文件夹后会显示剩余空间</span>
                )}
              </div>
            </div>

            {quickRoots.length > 0 && (
              <div>
                <div className='mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400'>
                  快捷磁盘
                </div>
                <div className='flex flex-wrap gap-1.5'>
                  {quickRoots.map((root) => (
                    <button
                      key={root.path}
                      type='button'
                      onClick={() => setDestDir(root.path)}
                      className={clsx(
                        'flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs transition',
                        destDir === root.path
                          ? 'border-primary-400 bg-primary-50 text-primary-600 dark:border-primary-500/50 dark:bg-primary-500/10 dark:text-primary-300'
                          : 'border-slate-200 text-slate-600 hover:border-primary-300 dark:border-white/[0.08] dark:text-slate-300'
                      )}
                    >
                      <MdStorage size={14} />
                      <span className='max-w-[140px] truncate'>{root.name}</span>
                      <span className='text-[10px] text-slate-400'>
                        {formatBytes(root.freeBytes)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Checkbox
              size='sm'
              isSelected={setDefault}
              onValueChange={setSetDefault}
            >
              把当前文件夹设为默认下载位置
            </Checkbox>

            <div className='rounded-2xl bg-slate-100/70 p-3 text-sm dark:bg-white/[0.04]'>
              <div className='flex items-center justify-between'>
                <span className='text-slate-500 dark:text-slate-400'>下载项</span>
                <span className='font-medium'>{items.length} 个</span>
              </div>
              {totalSize > 0 && (
                <div className='mt-1 flex items-center justify-between'>
                  <span className='text-slate-500 dark:text-slate-400'>总大小</span>
                  <span className='font-medium'>{formatBytes(totalSize)}</span>
                </div>
              )}
              <div className='mt-1 flex items-center justify-between gap-4'>
                <span className='shrink-0 text-slate-500 dark:text-slate-400'>保存到</span>
                <span className='min-w-0 break-all text-right font-mono text-xs'>
                  {destDir || '—'}
                </span>
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant='light' onPress={onClose} isDisabled={busy}>
              取消
            </Button>
            <Button
              color='primary'
              isLoading={busy}
              startContent={!busy ? <MdFolderOpen size={18} /> : undefined}
              onPress={() => void handleSubmit()}
            >
              开始下载
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <StorageBrowser
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        initialPath={destDir || defaultDir}
        title='选择下载文件夹'
        confirmLabel='下载到此处'
        onSelect={(path) => setDestDir(path)}
      />
    </>
  );
}
