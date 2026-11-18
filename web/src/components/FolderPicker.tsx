import { Button } from '@heroui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/modal';
import { Spinner } from '@heroui/spinner';
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { MdChevronRight, MdFolder, MdHome } from 'react-icons/md';
import toast from 'react-hot-toast';

import { api } from '@/lib/api';
import type { FileView } from '@/lib/types';

interface Crumb {
  fid: string;
  name: string;
}

export function FolderPicker({
  open,
  onClose,
  accountId,
  title = '选择网盘文件夹',
  confirmLabel = '选择此文件夹',
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  title?: string;
  confirmLabel?: string;
  onSelect: (fid: string, name: string) => void;
}) {
  const [stack, setStack] = useState<Crumb[]>([{ fid: '0', name: '全部文件' }]);
  const [entries, setEntries] = useState<FileView[]>([]);
  const [loading, setLoading] = useState(false);

  const current = stack[stack.length - 1];

  useEffect(() => {
    if (open) setStack([{ fid: '0', name: '全部文件' }]);
  }, [open]);

  const load = useCallback(
    async (fid: string) => {
      setLoading(true);
      try {
        const result = await api.listFiles(accountId, fid, 1, 200);
        setEntries(result.entries.filter((entry) => entry.isDir));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '读取目录失败');
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [accountId]
  );

  useEffect(() => {
    if (!open) return;
    void load(current.fid);
  }, [open, current.fid, load]);

  return (
    <Modal isOpen={open} onClose={onClose} size='xl' backdrop='blur'>
      <ModalContent>
        <ModalHeader className='text-lg'>{title}</ModalHeader>
        <ModalBody>
          <div className='flex flex-wrap items-center gap-1 rounded-2xl bg-slate-100/70 px-3 py-2 text-sm dark:bg-white/[0.04]'>
            {stack.map((crumb, index) => (
              <span key={`${crumb.fid}-${index}`} className='flex items-center gap-1'>
                {index > 0 && <MdChevronRight className='text-slate-400' size={16} />}
                <button
                  type='button'
                  className={clsx(
                    'rounded-lg px-1.5 py-0.5 transition hover:bg-white dark:hover:bg-white/[0.06]',
                    index === stack.length - 1
                      ? 'font-medium text-primary-600 dark:text-primary-300'
                      : 'text-slate-500 dark:text-slate-400'
                  )}
                  onClick={() => setStack((value) => value.slice(0, index + 1))}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>

          <div className='mt-2 h-[320px] overflow-y-auto rounded-2xl border border-slate-200/80 p-1.5 dark:border-white/[0.06]'>
            {stack.length > 1 && (
              <button
                type='button'
                onClick={() => setStack((value) => value.slice(0, -1))}
                className='file-row w-full grid-cols-[42px_1fr_auto] text-left'
              >
                <span className='flex h-10 w-10 items-center justify-center rounded-xl bg-slate-200/60 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400'>
                  <MdHome size={20} />
                </span>
                <span className='text-sm text-slate-500 dark:text-slate-400'>返回上一级</span>
              </button>
            )}
            {loading ? (
              <div className='flex h-40 items-center justify-center'>
                <Spinner color='primary' />
              </div>
            ) : entries.length === 0 ? (
              <div className='flex h-40 flex-col items-center justify-center gap-2 text-sm text-slate-400'>
                <MdFolder size={28} />
                当前目录没有子文件夹
              </div>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.fid}
                  type='button'
                  onClick={() => setStack((value) => [...value, { fid: entry.fid, name: entry.name }])}
                  className='file-row w-full grid-cols-[42px_1fr_auto] text-left'
                >
                  <span className='flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400/15 text-amber-500'>
                    <MdFolder size={22} />
                  </span>
                  <span className='truncate text-sm text-slate-700 dark:text-slate-200'>
                    {entry.name}
                  </span>
                  <MdChevronRight className='text-slate-300' size={18} />
                </button>
              ))
            )}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant='light' onPress={onClose}>
            取消
          </Button>
          <Button
            color='primary'
            onPress={() => {
              onSelect(current.fid, current.name);
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
