import { Button } from '@heroui/button';
import { Checkbox } from '@heroui/checkbox';
import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
} from '@heroui/dropdown';
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
  MdChevronRight,
  MdCreateNewFolder,
  MdDeleteOutline,
  MdDownload,
  MdDriveFileMove,
  MdEdit,
  MdFolderOpen,
  MdGridView,
  MdMoreHoriz,
  MdRefresh,
  MdSearch,
  MdViewList,
} from 'react-icons/md';
import toast from 'react-hot-toast';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DownloadDialog } from '@/components/DownloadDialog';
import { EmptyState } from '@/components/EmptyState';
import { FileContextMenu, type ContextMenuItem } from '@/components/FileContextMenu';
import { FileIcon } from '@/components/FileIcon';
import { FolderPicker } from '@/components/FolderPicker';
import { useApp } from '@/context/app';
import { api } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import type { DownloadItem, FileView } from '@/lib/types';

interface Crumb {
  fid: string;
  name: string;
}

type SortKey = 'name' | 'size' | 'updatedAt';

export default function FilesPage() {
  const { activeAccountId, settings, refreshTransfers } = useApp();
  const [stack, setStack] = useState<Crumb[]>([{ fid: '0', name: '全部文件' }]);
  const [entries, setEntries] = useState<FileView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: 'name',
    dir: 1,
  });

  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadItems, setDownloadItems] = useState<DownloadItem[]>([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [permanentDelete, setPermanentDelete] = useState(false);
  const [nameDialog, setNameDialog] = useState<'mkdir' | 'rename' | null>(null);
  const [nameValue, setNameValue] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targets: FileView[];
  } | null>(null);

  const current = stack[stack.length - 1];

  const handleError = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
    },
    []
  );

  const load = useCallback(
    async (fid: string, pageNumber = 1, append = false) => {
      if (!activeAccountId) return;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const result = await api.listFiles(activeAccountId, fid, pageNumber, 200);
        setEntries((currentEntries) =>
          append ? [...currentEntries, ...result.entries] : result.entries
        );
        setTotal(result.total);
        setPage(pageNumber);
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
    setStack([{ fid: '0', name: '全部文件' }]);
    setSelected(new Set());
  }, [activeAccountId]);

  useEffect(() => {
    if (!activeAccountId) return;
    setSelected(new Set());
    void load(current.fid, 1, false);
  }, [activeAccountId, current.fid, load]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const list = keyword
      ? entries.filter((entry) => entry.name.toLowerCase().includes(keyword))
      : entries.slice();
    list.sort((left, right) => {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
      let result = 0;
      if (sort.key === 'name') {
        result = left.name.localeCompare(right.name, 'zh-CN');
      } else if (sort.key === 'size') {
        result = left.size - right.size;
      } else {
        result = left.updatedAt - right.updatedAt;
      }
      return result * sort.dir;
    });
    return list;
  }, [entries, query, sort]);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entry.fid)),
    [entries, selected]
  );
  const allSelected = filtered.length > 0 && filtered.every((entry) => selected.has(entry.fid));
  const someSelected = selected.size > 0 && !allSelected;

  const toggleSelect = (fid: string) => {
    setSelected((currentSelected) => {
      const next = new Set(currentSelected);
      if (next.has(fid)) next.delete(fid);
      else next.add(fid);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((currentSelected) => {
      if (filtered.every((entry) => currentSelected.has(entry.fid))) {
        return new Set();
      }
      return new Set(filtered.map((entry) => entry.fid));
    });
  };

  const openEntry = (entry: FileView) => {
    if (entry.isDir) {
      setStack((value) => [...value, { fid: entry.fid, name: entry.name }]);
      setQuery('');
    } else {
      setDownloadItems([
        { fid: entry.fid, name: entry.name, size: entry.size, isDir: false },
      ]);
      setDownloadOpen(true);
    }
  };

  const startDownload = (items: FileView[]) => {
    if (!items.length) return;
    setDownloadItems(
      items.map((entry) => ({
        fid: entry.fid,
        name: entry.name,
        size: entry.size,
        isDir: entry.isDir,
      }))
    );
    setDownloadOpen(true);
  };

  const openContextMenu = (event: React.MouseEvent, entry: FileView) => {
    event.preventDefault();
    event.stopPropagation();
    const currentSelected = selectedEntries;
    const targets =
      selected.has(entry.fid) && currentSelected.length > 0
        ? currentSelected
        : [entry];
    if (!selected.has(entry.fid)) {
      setSelected(new Set([entry.fid]));
    }
    setContextMenu({ x: event.clientX, y: event.clientY, targets });
  };

  const handleContextAction = (key: string) => {
    if (!contextMenu) return;
    const targets = contextMenu.targets;
    if (key === 'open') {
      if (targets.length === 1 && targets[0].isDir) openEntry(targets[0]);
    } else if (key === 'download') {
      startDownload(targets);
    } else if (key === 'rename') {
      if (targets.length === 1) {
        setSelected(new Set([targets[0].fid]));
        setNameValue(targets[0].name);
        setNameDialog('rename');
      }
    } else if (key === 'move') {
      setSelected(new Set(targets.map((target) => target.fid)));
      setMoveOpen(true);
    } else if (key === 'delete') {
      setSelected(new Set(targets.map((target) => target.fid)));
      setPermanentDelete(false);
      setDeleteOpen(true);
    }
    setContextMenu(null);
  };

  const contextItems: ContextMenuItem[] = contextMenu
    ? [
        ...(contextMenu.targets.length === 1 && contextMenu.targets[0].isDir
          ? [
              {
                key: 'open',
                label: '打开',
                icon: <MdFolderOpen size={16} />,
              },
            ]
          : []),
        {
          key: 'download',
          label:
            contextMenu.targets.length > 1
              ? `下载 ${contextMenu.targets.length} 项到服务器`
              : '下载到服务器',
          icon: <MdDownload size={16} />,
        },
        {
          key: 'rename',
          label: '重命名',
          icon: <MdEdit size={16} />,
          disabled: contextMenu.targets.length !== 1,
          dividerBefore: true,
        },
        {
          key: 'move',
          label: '移动到…',
          icon: <MdDriveFileMove size={16} />,
        },
        {
          key: 'delete',
          label:
            contextMenu.targets.length > 1
              ? `删除 ${contextMenu.targets.length} 项`
              : '删除',
          icon: <MdDeleteOutline size={16} />,
          danger: true,
          dividerBefore: true,
        },
      ]
    : [];

  const handleMkdir = async () => {
    if (!activeAccountId) return;
    const name = nameValue.trim();
    if (!name) {
      toast.error('请输入文件夹名称');
      return;
    }
    setNameBusy(true);
    try {
      await api.mkdir(activeAccountId, current.fid, name);
      toast.success('文件夹已创建');
      setNameDialog(null);
      setNameValue('');
      await load(current.fid);
    } catch (error) {
      handleError(error);
    } finally {
      setNameBusy(false);
    }
  };

  const handleRename = async () => {
    if (!activeAccountId || selectedEntries.length !== 1) return;
    const name = nameValue.trim();
    if (!name) {
      toast.error('请输入新名称');
      return;
    }
    setNameBusy(true);
    try {
      await api.rename(activeAccountId, selectedEntries[0].fid, name);
      toast.success('已重命名');
      setNameDialog(null);
      setNameValue('');
      await load(current.fid);
    } catch (error) {
      handleError(error);
    } finally {
      setNameBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!activeAccountId) return;
    try {
      await api.deleteFiles(
        activeAccountId,
        selectedEntries.map((entry) => entry.fid),
        permanentDelete
      );
      toast.success(permanentDelete ? '已彻底删除' : '已移入回收站');
      setSelected(new Set());
      setDeleteOpen(false);
      await load(current.fid);
    } catch (error) {
      handleError(error);
    }
  };

  const handleMove = async (fid: string) => {
    if (!activeAccountId) return;
    try {
      await api.moveFiles(
        activeAccountId,
        selectedEntries.map((entry) => entry.fid),
        fid
      );
      toast.success('已移动');
      setSelected(new Set());
      await load(current.fid);
    } catch (error) {
      handleError(error);
    }
  };

  const sortHeader = (key: SortKey, label: string) => (
    <button
      type='button'
      className={clsx(
        'flex items-center gap-1 whitespace-nowrap text-xs font-medium transition hover:text-primary-500',
        sort.key === key ? 'text-primary-500' : 'text-slate-500 dark:text-slate-400'
      )}
      onClick={() =>
        setSort((value) =>
          value.key === key ? { key, dir: value.dir === 1 ? -1 : 1 } : { key, dir: 1 }
        )
      }
    >
      {label}
      {sort.key === key && <span className='text-[10px]'>{sort.dir === 1 ? '↑' : '↓'}</span>}
    </button>
  );

  if (!activeAccountId) return null;

  return (
    <div className='animate-float-in space-y-4'>
      <div className='glass-card overflow-hidden'>
        <div className='flex flex-col gap-3 border-b border-slate-200/70 px-4 py-3.5 dark:border-white/[0.07] md:flex-row md:items-center'>
          <div className='flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm'>
            {stack.map((crumb, index) => (
              <span key={`${crumb.fid}-${index}`} className='flex shrink-0 items-center gap-1'>
                {index > 0 && <MdChevronRight className='text-slate-300' size={18} />}
                <button
                  type='button'
                  className={clsx(
                    'rounded-lg px-1.5 py-1 transition hover:bg-white/80 dark:hover:bg-white/[0.06]',
                    index === stack.length - 1
                      ? 'font-semibold text-slate-900 dark:text-white'
                      : 'text-slate-500 dark:text-slate-400'
                  )}
                  onClick={() => setStack((value) => value.slice(0, index + 1))}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
            <span className='ml-2 shrink-0 text-xs text-slate-400'>
              共 {total} 项
            </span>
          </div>

          <div className='flex items-center gap-2'>
            <Input
              size='sm'
              radius='lg'
              placeholder='搜索当前目录'
              value={query}
              onValueChange={setQuery}
              startContent={<MdSearch className='text-slate-400' size={17} />}
              className='w-full md:w-56'
              classNames={{ inputWrapper: 'bg-white/70 dark:bg-white/[0.04]' }}
            />
            <Tooltip content='刷新'>
              <Button
                isIconOnly
                size='sm'
                variant='light'
                onPress={() => void load(current.fid)}
                isDisabled={loading}
              >
                <MdRefresh size={18} />
              </Button>
            </Tooltip>
            <div className='flex rounded-xl bg-slate-100/80 p-0.5 dark:bg-white/[0.05]'>
              <button
                type='button'
                onClick={() => setView('list')}
                className={clsx(
                  'rounded-lg p-1.5 transition',
                  view === 'list'
                    ? 'bg-white text-primary-500 shadow-sm dark:bg-white/[0.1]'
                    : 'text-slate-400'
                )}
                aria-label='列表视图'
              >
                <MdViewList size={18} />
              </button>
              <button
                type='button'
                onClick={() => setView('grid')}
                className={clsx(
                  'rounded-lg p-1.5 transition',
                  view === 'grid'
                    ? 'bg-white text-primary-500 shadow-sm dark:bg-white/[0.1]'
                    : 'text-slate-400'
                )}
                aria-label='网格视图'
              >
                <MdGridView size={18} />
              </button>
            </div>
          </div>
        </div>

        <div className='flex flex-wrap items-center gap-2 px-3 py-2.5'>
          <Button
            size='sm'
            color='primary'
            startContent={<MdCreateNewFolder size={17} />}
            onPress={() => {
              setNameValue('');
              setNameDialog('mkdir');
            }}
          >
            新建文件夹
          </Button>
          <Button
            size='sm'
            variant='flat'
            startContent={<MdDownload size={17} />}
            isDisabled={selected.size === 0}
            onPress={() => startDownload(selectedEntries)}
          >
            下载
          </Button>
          <Button
            size='sm'
            variant='flat'
            startContent={<MdDriveFileMove size={17} />}
            isDisabled={selected.size === 0}
            onPress={() => setMoveOpen(true)}
          >
            移动
          </Button>
          <Button
            size='sm'
            variant='flat'
            startContent={<MdEdit size={16} />}
            isDisabled={selected.size !== 1}
            onPress={() => {
              setNameValue(selectedEntries[0]?.name ?? '');
              setNameDialog('rename');
            }}
          >
            重命名
          </Button>
          <Button
            size='sm'
            variant='flat'
            className='text-danger'
            startContent={<MdDeleteOutline size={17} />}
            isDisabled={selected.size === 0}
            onPress={() => {
              setPermanentDelete(false);
              setDeleteOpen(true);
            }}
          >
            删除
          </Button>
          {selected.size > 0 && (
            <span className='ml-auto text-xs text-slate-500 dark:text-slate-400'>
              已选 {selected.size} 项 · {formatBytes(
                selectedEntries.reduce((sum, entry) => sum + entry.size, 0)
              )}
            </span>
          )}
        </div>
      </div>

      <div className='glass-card min-h-[420px] p-2 md:p-3'>
        {loading ? (
          <div className='flex h-[380px] items-center justify-center'>
            <Spinner color='primary' label='正在读取目录…' />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={query ? '没有匹配的文件' : '这个文件夹是空的'}
            description={query ? '换个关键词试试' : '新建文件夹，或者从其他目录移动文件过来'}
          />
        ) : view === 'list' ? (
          <div>
            <div className='grid grid-cols-[28px_1fr_32px] items-center gap-3 border-b border-slate-200/60 px-3 pb-2 text-[11px] dark:border-white/[0.06] md:grid-cols-[28px_1fr_120px_170px_44px]'>
              <Checkbox
                size='sm'
                aria-label='全选'
                isSelected={allSelected}
                isIndeterminate={someSelected}
                onValueChange={toggleSelectAll}
              />
              {sortHeader('name', '文件名')}
              <span className='hidden md:block'>{sortHeader('size', '大小')}</span>
              <span className='hidden md:block'>{sortHeader('updatedAt', '修改时间')}</span>
              <span className='text-right text-slate-400'>操作</span>
            </div>
            <div className='mt-1 space-y-0.5'>
              {filtered.map((entry) => {
                const isSelected = selected.has(entry.fid);
                return (
                  <div
                    key={entry.fid}
                    role='button'
                    tabIndex={0}
                    onClick={() => toggleSelect(entry.fid)}
                    onDoubleClick={() => openEntry(entry)}
                    onContextMenu={(event) => openContextMenu(event, entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') openEntry(entry);
                      if (event.key === ' ') {
                        event.preventDefault();
                        toggleSelect(entry.fid);
                      }
                    }}
                    className={clsx(
                      'file-row cursor-default grid-cols-[28px_1fr_32px] md:grid-cols-[28px_1fr_120px_170px_44px]',
                      isSelected && 'file-row-selected'
                    )}
                  >
                    <div onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        size='sm'
                        aria-label={`选择 ${entry.name}`}
                        isSelected={isSelected}
                        onValueChange={() => toggleSelect(entry.fid)}
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
                    <div className='hidden truncate text-xs text-slate-500 dark:text-slate-400 md:block'>
                      {entry.isDir ? '—' : formatBytes(entry.size)}
                    </div>
                    <div className='hidden truncate text-xs text-slate-500 dark:text-slate-400 md:block'>
                      {formatDate(entry.updatedAt)}
                    </div>
                    <div className='flex justify-end' onClick={(event) => event.stopPropagation()}>
                      <Dropdown placement='bottom-end'>
                        <DropdownTrigger>
                          <Button isIconOnly size='sm' variant='light' aria-label='文件操作'>
                            <MdMoreHoriz size={20} />
                          </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                          aria-label='文件操作'
                          onAction={(key) => {
                            if (key === 'download') startDownload([entry]);
                            if (key === 'rename') {
                              setSelected(new Set([entry.fid]));
                              setNameValue(entry.name);
                              setNameDialog('rename');
                            }
                            if (key === 'move') {
                              setSelected(new Set([entry.fid]));
                              setMoveOpen(true);
                            }
                            if (key === 'delete') {
                              setSelected(new Set([entry.fid]));
                              setPermanentDelete(false);
                              setDeleteOpen(true);
                            }
                            if (key === 'open' && entry.isDir) openEntry(entry);
                          }}
                        >
                          <DropdownItem key='open' isDisabled={!entry.isDir}>
                            打开
                          </DropdownItem>
                          <DropdownItem key='download'>下载到服务器</DropdownItem>
                          <DropdownItem key='rename'>重命名</DropdownItem>
                          <DropdownItem key='move'>移动到…</DropdownItem>
                          <DropdownItem key='delete' className='text-danger' color='danger'>
                            删除
                          </DropdownItem>
                        </DropdownMenu>
                      </Dropdown>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className='grid grid-cols-2 gap-2.5 p-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'>
            {filtered.map((entry) => {
              const isSelected = selected.has(entry.fid);
              return (
                <div
                  key={entry.fid}
                  role='button'
                  tabIndex={0}
                  onClick={() => toggleSelect(entry.fid)}
                  onDoubleClick={() => openEntry(entry)}
                  onContextMenu={(event) => openContextMenu(event, entry)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') openEntry(entry);
                  }}
                  className={clsx(
                    'group relative flex flex-col items-center gap-3 rounded-3xl border p-4 text-center transition',
                    isSelected
                      ? 'border-primary-300 bg-primary-50/70 dark:border-primary-500/40 dark:bg-primary-500/10'
                      : 'border-transparent bg-slate-50/60 hover:border-primary-200 hover:bg-white dark:bg-white/[0.025] dark:hover:border-primary-500/30 dark:hover:bg-white/[0.05]'
                  )}
                >
                  <div className='absolute left-2 top-2 opacity-0 transition group-hover:opacity-100 data-[selected=true]:opacity-100' data-selected={isSelected}>
                    <div onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        size='sm'
                        aria-label={`选择 ${entry.name}`}
                        isSelected={isSelected}
                        onValueChange={() => toggleSelect(entry.fid)}
                      />
                    </div>
                  </div>
                  <FileIcon name={entry.name} isDir={entry.isDir} size='lg' className='mt-2' />
                  <div className='w-full'>
                    <div className='line-clamp-2 min-h-[36px] break-all text-sm font-medium text-slate-800 dark:text-slate-100'>
                      {entry.name}
                    </div>
                    <div className='mt-1 text-[11px] text-slate-400'>
                      {entry.isDir ? '文件夹' : formatBytes(entry.size)} · {formatDate(entry.updatedAt)}
                    </div>
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
              onPress={() => void load(current.fid, page + 1, true)}
            >
              加载更多（已加载 {entries.length} / {total}）
            </Button>
          </div>
        )}
      </div>

      <FileContextMenu
        open={contextMenu !== null}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        items={contextItems}
        onSelect={handleContextAction}
        onClose={() => setContextMenu(null)}
      />

      <DownloadDialog
        open={downloadOpen}
        onClose={() => setDownloadOpen(false)}
        accountId={activeAccountId}
        items={downloadItems}
        defaultDir={settings?.downloadDir}
        onEnqueued={refreshTransfers}
      />

      <FolderPicker
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        accountId={activeAccountId}
        title={`移动 ${selected.size} 个项目`}
        confirmLabel='移动到此处'
        onSelect={(fid) => void handleMove(fid)}
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={permanentDelete ? '彻底删除' : '移入回收站'}
        description={
          <div className='space-y-2'>
            <p>
              确定要{permanentDelete ? '彻底删除' : '删除'}选中的 {selected.size} 个项目吗？
              {permanentDelete ? '彻底删除后无法恢复。' : '之后可以在回收站中恢复。'}
            </p>
            <label className='flex items-center gap-2 text-xs'>
              <input
                type='checkbox'
                checked={permanentDelete}
                onChange={(event) => setPermanentDelete(event.target.checked)}
              />
              彻底删除（不进入回收站）
            </label>
          </div>
        }
        confirmLabel='删除'
        danger
        onConfirm={handleDelete}
      />

      <Modal
        isOpen={nameDialog !== null}
        onClose={() => setNameDialog(null)}
        size='sm'
        backdrop='blur'
      >
        <ModalContent>
          <ModalHeader>{nameDialog === 'mkdir' ? '新建文件夹' : '重命名'}</ModalHeader>
          <ModalBody>
            <Input
              autoFocus
              label={nameDialog === 'mkdir' ? '文件夹名称' : '新名称'}
              value={nameValue}
              onValueChange={setNameValue}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void (nameDialog === 'mkdir' ? handleMkdir() : handleRename());
                }
              }}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant='light' onPress={() => setNameDialog(null)} isDisabled={nameBusy}>
              取消
            </Button>
            <Button
              color='primary'
              isLoading={nameBusy}
              onPress={() => void (nameDialog === 'mkdir' ? handleMkdir() : handleRename())}
            >
              确定
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
