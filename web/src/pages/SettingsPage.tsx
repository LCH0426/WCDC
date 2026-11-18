import { Avatar } from '@heroui/avatar';
import { Button } from '@heroui/button';
import { Chip } from '@heroui/chip';
import { Input } from '@heroui/input';
import { Slider } from '@heroui/slider';
import { Switch } from '@heroui/switch';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import {
  MdComputer,
  MdFolderOpen,
  MdLockOutline,
  MdLogout,
  MdMemory,
  MdOutlineRefresh,
  MdSpeed,
  MdStorage,
  MdWifi,
} from 'react-icons/md';
import toast from 'react-hot-toast';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StorageBrowser } from '@/components/StorageBrowser';
import { useApp } from '@/context/app';
import { api } from '@/lib/api';
import { formatBytes, formatExpire, formatSpeed } from '@/lib/format';
import type { ServerInfo, StorageRoot } from '@/lib/types';

function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [
    days ? `${days} 天` : null,
    hours ? `${hours} 小时` : null,
    `${minutes} 分钟`,
  ]
    .filter(Boolean)
    .join(' ');
}

export default function SettingsPage() {
  const {
    activeAccount,
    accounts,
    settings,
    volumes,
    saveSettings,
    logout,
    refreshAccount,
    refreshVolumes,
  } = useApp();
  const [concurrency, setConcurrency] = useState(settings?.concurrency ?? 2);
  const [maxSpeedMb, setMaxSpeedMb] = useState(
    String(Math.round((settings?.maxSpeedBps ?? 0) / 1024 / 1024) || 0)
  );
  const [busy, setBusy] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [roots, setRoots] = useState<StorageRoot[]>([]);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [destInfo, setDestInfo] = useState<{
    freeBytes: number;
    totalBytes: number;
    writable: boolean;
  } | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [lanOnly, setLanOnly] = useState(settings?.lanOnly ?? true);

  useEffect(() => {
    setLanOnly(settings?.lanOnly ?? true);
  }, [settings?.lanOnly]);

  const toggleLanOnly = async (value: boolean) => {
    setLanOnly(value);
    try {
      await saveSettings({ lanOnly: value });
      toast.success(value ? '已开启：只允许内网登录' : '已允许非内网地址登录');
    } catch (error) {
      setLanOnly(!value);
      toast.error(error instanceof Error ? error.message : '设置失败');
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api
        .serverInfo()
        .then((info) => {
          if (!cancelled) setServerInfo(info);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const loadRoots = () => {
    void api
      .storageRoots()
      .then((info) => setRoots(info.roots))
      .catch(() => setRoots([]));
  };

  useEffect(() => {
    loadRoots();
  }, []);

  useEffect(() => {
    const dir = settings?.downloadDir;
    if (!dir) {
      setDestInfo(null);
      return;
    }
    let cancelled = false;
    void api
      .browseStorage(dir)
      .then((info) => {
        if (!cancelled) {
          setDestInfo({
            freeBytes: info.freeBytes,
            totalBytes: info.totalBytes,
            writable: info.writable,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setDestInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [settings?.downloadDir]);

  useEffect(() => {
    if (settings) {
      setConcurrency(settings.concurrency);
      setMaxSpeedMb(String(Math.round(settings.maxSpeedBps / 1024 / 1024) || 0));
    }
  }, [settings]);

  const usedPercent = activeAccount?.totalSpace
    ? Math.min(100, (activeAccount.usedSpace / activeAccount.totalSpace) * 100)
    : 0;

  const save = async () => {
    setBusy(true);
    try {
      const speed = Math.max(0, Number(maxSpeedMb) || 0) * 1024 * 1024;
      await saveSettings({ concurrency, maxSpeedBps: speed });
      toast.success('设置已保存');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const setDefaultDir = async (path: string) => {
    setBusy(true);
    try {
      await saveSettings({ downloadDir: path });
      toast.success('默认下载位置已更新');
      loadRoots();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '设置默认位置失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className='animate-float-in grid gap-4 lg:grid-cols-2'>
      <div className='contents'>
        <div className='glass-card p-5 order-1'>
          <div className='flex flex-wrap items-center gap-3'>
            <Avatar
              size='lg'
              src={activeAccount?.avatarUrl || undefined}
              name={activeAccount?.nickname?.slice(0, 1) || 'Q'}
              className='bg-primary-500 text-white'
            />
            <div className='min-w-0 flex-1'>
              <div className='flex items-center gap-2'>
                <span className='truncate text-lg font-semibold text-slate-900 dark:text-white'>
                  {activeAccount?.nickname || '未登录'}
                </span>
                {activeAccount?.isVip && (
                  <Chip size='sm' className='bg-gradient-to-r from-amber-400 to-orange-500 text-white'>
                    {activeAccount.vipType || 'VIP'}
                  </Chip>
                )}
              </div>
              <div className='mt-0.5 text-xs text-slate-500 dark:text-slate-400'>
                UID {activeAccount?.uid || '—'}
                {activeAccount?.vipExpireAt ? ` · ${formatExpire(activeAccount.vipExpireAt)}` : ''}
              </div>
            </div>
            <div className='flex items-center gap-2'>
              <Button
                size='sm'
                variant='flat'
                startContent={<MdOutlineRefresh size={16} />}
                onPress={async () => {
                  if (!activeAccount) return;
                  try {
                    await refreshAccount(activeAccount.id);
                    toast.success('账号信息已刷新');
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : '刷新失败');
                  }
                }}
              >
                刷新
              </Button>
              <Button
                size='sm'
                variant='flat'
                className='text-danger'
                startContent={<MdLogout size={16} />}
                onPress={() => setLogoutOpen(true)}
              >
                退出
              </Button>
            </div>
          </div>

          <div className='mt-5'>
            <div className='flex items-center justify-between text-xs text-slate-500 dark:text-slate-400'>
              <span>存储空间</span>
              <span>
                {formatBytes(activeAccount?.usedSpace)} / {formatBytes(activeAccount?.totalSpace)}
              </span>
            </div>
            <div className='mt-2 h-2 overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/[0.08]'>
              <div
                className='h-full rounded-full bg-gradient-to-r from-primary-400 to-indigo-500'
                style={{ width: `${usedPercent}%` }}
              />
            </div>
          </div>

          <div className='mt-5 rounded-2xl bg-slate-100/70 p-3 text-xs text-slate-500 dark:bg-white/[0.04] dark:text-slate-400'>
            已绑定 {accounts.length} 个夸克账号。切换账号请使用左下角账号菜单；添加账号会打开扫码弹窗。
          </div>
        </div>

        <div className='glass-card p-5 order-5'>
          <div className='text-base font-semibold text-slate-900 dark:text-white'>下载设置</div>
          <div className='mt-1 text-xs text-slate-500 dark:text-slate-400'>
            下载任务由服务端执行，断点续传、分片并发数在此控制。
          </div>

          <div className='mt-5 space-y-6'>
            <div>
              <div className='mb-2 flex items-center justify-between text-sm'>
                <span className='text-slate-700 dark:text-slate-200'>并发任务数</span>
                <span className='font-mono text-primary-500'>{concurrency}</span>
              </div>
              <Slider
                aria-label='并发任务数'
                minValue={1}
                maxValue={6}
                step={1}
                value={concurrency}
                onChange={(value) => setConcurrency(Number(value))}
                showSteps
                className='max-w-full'
              />
              <div className='mt-1 text-[11px] text-slate-400'>
                同时下载的文件数量，过大可能触发夸克限速。
              </div>
            </div>

            <div>
              <Input
                type='number'
                min='0'
                label='单任务限速（MB/s）'
                labelPlacement='outside'
                placeholder='0 表示不限速'
                value={maxSpeedMb}
                onValueChange={setMaxSpeedMb}
                description='当前版本后端按核心队列调度，限速值为保存的偏好设置。'
              />
            </div>

            <div className='flex justify-end'>
              <Button color='primary' isLoading={busy} onPress={() => void save()}>
                保存设置
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className='contents'>
        <div className='glass-card p-5 order-2'>
          <div className='flex items-center gap-2'>
            <MdComputer className='text-primary-500' size={20} />
            <div className='text-base font-semibold text-slate-900 dark:text-white'>
              服务器信息
            </div>
            <span className='ml-auto text-[10px] text-slate-400'>每 2 秒刷新</span>
          </div>

          <div className='mt-4 grid gap-3 sm:grid-cols-2'>
            <div className='rounded-2xl border border-slate-200/70 bg-white/50 p-3 dark:border-white/[0.06] dark:bg-white/[0.03]'>
              <div className='flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400'>
                <MdSpeed size={16} className='text-primary' /> CPU
                <span className='ml-auto font-mono text-sm text-slate-800 dark:text-slate-100'>
                  {serverInfo ? `${serverInfo.cpuUsagePercent.toFixed(1)}%` : '—'}
                </span>
              </div>
              <div className='mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/[0.08]'>
                <div
                  className='h-full rounded-full bg-gradient-to-r from-primary-300 to-primary transition-all'
                  style={{
                    width: `${Math.min(100, serverInfo?.cpuUsagePercent ?? 0)}%`,
                  }}
                />
              </div>
              <div className='mt-1.5 truncate text-[10px] text-slate-400'>
                {serverInfo
                  ? `${serverInfo.cpuBrand || 'CPU'} · ${serverInfo.cpuCores} 核`
                  : '正在采集…'}
              </div>
            </div>

            <div className='rounded-2xl border border-slate-200/70 bg-white/50 p-3 dark:border-white/[0.06] dark:bg-white/[0.03]'>
              <div className='flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400'>
                <MdMemory size={16} className='text-emerald-500' /> 内存
                <span className='ml-auto font-mono text-sm text-slate-800 dark:text-slate-100'>
                  {serverInfo ? `${formatBytes(serverInfo.memoryUsedBytes)} / ${formatBytes(serverInfo.memoryTotalBytes)}` : '—'}
                </span>
              </div>
              <div className='mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/[0.08]'>
                <div
                  className='h-full rounded-full bg-gradient-to-r from-emerald-300 to-emerald-500 transition-all'
                  style={{
                    width: `${
                      serverInfo?.memoryTotalBytes
                        ? Math.min(
                            100,
                            (serverInfo.memoryUsedBytes /
                              serverInfo.memoryTotalBytes) *
                              100
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
              <div className='mt-1.5 text-[10px] text-slate-400'>
                {serverInfo
                  ? `可用 ${formatBytes(serverInfo.memoryAvailableBytes)}`
                  : '正在采集…'}
              </div>
            </div>
          </div>

          <div className='mt-3 rounded-2xl bg-slate-100/70 p-3 dark:bg-white/[0.04]'>
            <div className='flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400'>
              <MdWifi size={16} className='text-sky-500' /> 网络速度
            </div>
            <div className='mt-2 grid grid-cols-2 gap-3 text-sm'>
              <div>
                <div className='text-[10px] text-slate-400'>下行</div>
                <div className='font-mono text-slate-800 dark:text-slate-100'>
                  {formatSpeed(serverInfo?.networkReceivedBps)}
                </div>
                <div className='text-[10px] text-slate-400'>
                  累计 {formatBytes(serverInfo?.networkTotalReceivedBytes)}
                </div>
              </div>
              <div>
                <div className='text-[10px] text-slate-400'>上行</div>
                <div className='font-mono text-slate-800 dark:text-slate-100'>
                  {formatSpeed(serverInfo?.networkTransmittedBps)}
                </div>
                <div className='text-[10px] text-slate-400'>
                  累计 {formatBytes(serverInfo?.networkTotalTransmittedBytes)}
                </div>
              </div>
            </div>
          </div>

          <div className='mt-3 grid grid-cols-[70px_1fr] gap-x-2 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400'>
            <span className='text-slate-400'>主机</span>
            <span className='truncate'>{serverInfo?.hostName || '—'}</span>
            <span className='text-slate-400'>系统</span>
            <span className='truncate'>
              {serverInfo
                ? `${serverInfo.osName} ${serverInfo.osVersion}`.trim()
                : '—'}
            </span>
            <span className='text-slate-400'>运行时间</span>
            <span>{formatUptime(serverInfo?.uptimeSeconds ?? 0)}</span>
          </div>
        </div>

        <div className='glass-card p-5 order-4'>
          <div className='flex flex-wrap items-center gap-2'>
            <MdFolderOpen className='text-primary-500' size={20} />
            <div className='text-base font-semibold text-slate-900 dark:text-white'>
              默认下载位置
            </div>
            <Button
              size='sm'
              variant='flat'
              className='ml-auto'
              startContent={<MdStorage size={16} />}
              onPress={() => setBrowseOpen(true)}
            >
              {settings?.fnosMode ? '选择授权文件夹…' : '浏览所有磁盘…'}
            </Button>
          </div>
          <div className='mt-3 rounded-2xl border border-slate-200/80 bg-white/60 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.04]'>
            <div className='break-all font-mono text-[11px] text-slate-700 dark:text-slate-200'>
              {settings?.downloadDir || '尚未设置'}
            </div>
            <div className='mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400'>
              {destInfo ? (
                <>
                  <span>剩余 {formatBytes(destInfo.freeBytes)}</span>
                  <span>共 {formatBytes(destInfo.totalBytes)}</span>
                  <span
                    className={clsx(
                      'rounded-md px-1.5 py-0.5',
                      destInfo.writable
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                    )}
                  >
                    {destInfo.writable ? '可写' : '不可写'}
                  </span>
                </>
              ) : (
                <span>目录不可用或不存在</span>
              )}
            </div>
          </div>

          <div className='mt-4 text-xs font-medium text-slate-500 dark:text-slate-400'>
            {settings?.fnosMode ? '授权文件夹' : '全部磁盘 / 挂载点'}
          </div>
          <div className='mt-2 space-y-2'>
            {roots.map((root) => {
              const active = settings?.downloadDir === root.path;
              return (
                <div
                  key={root.path}
                  className={clsx(
                    'flex flex-wrap items-center gap-2 rounded-2xl border p-2.5',
                    active
                      ? 'border-primary-300 bg-primary-50/60 dark:border-primary-500/40 dark:bg-primary-500/10'
                      : 'border-slate-200/70 bg-white/50 dark:border-white/[0.06] dark:bg-white/[0.03]'
                  )}
                >
                  <MdStorage className='shrink-0 text-slate-400' size={18} />
                  <div className='min-w-0 flex-1'>
                    <div className='flex items-center gap-2'>
                      <span className='truncate text-sm font-medium text-slate-800 dark:text-slate-100'>
                        {root.name}
                      </span>
                      <span className='rounded-md bg-slate-500/10 px-1.5 py-0.5 text-[10px] text-slate-500 dark:text-slate-400'>
                        {formatBytes(root.freeBytes)} 可用
                      </span>
                    </div>
                    <div className='truncate font-mono text-[10px] text-slate-400'>
                      {root.path}
                    </div>
                  </div>
                  <Button
                    size='sm'
                    variant={active ? 'flat' : 'light'}
                    isDisabled={active || busy || !root.writable}
                    onPress={() => void setDefaultDir(root.path)}
                  >
                    {active ? '当前默认' : '设为默认'}
                  </Button>
                </div>
              );
            })}
            {roots.length === 0 && (
              <div className='rounded-2xl border border-dashed border-slate-300 p-4 text-center text-xs text-slate-400 dark:border-white/10'>
                没有读取到磁盘信息
              </div>
            )}
          </div>
        </div>

        <div className='glass-card p-5 order-3'>
          <div className='flex items-center gap-2'>
            <MdStorage className='text-primary-500' size={20} />
            <div className='text-base font-semibold text-slate-900 dark:text-white'>快捷存储盘</div>
            <Button
              size='sm'
              variant='light'
              className='ml-auto'
              onPress={() => void refreshVolumes()}
            >
              刷新
            </Button>
          </div>
          <div className='mt-1 text-xs text-slate-500 dark:text-slate-400'>
            可选：在 volumes.json 中预置常用目录，便于快速识别；下载时仍可选择任意磁盘。
          </div>
          <div className='mt-4 space-y-2.5'>
            {volumes.map((volume) => {
              const used = volume.totalBytes - volume.freeBytes;
              const percent = volume.totalBytes
                ? Math.min(100, (used / volume.totalBytes) * 100)
                : 0;
              return (
                <div
                  key={volume.id}
                  className='rounded-2xl border border-slate-200/70 bg-white/50 p-3 dark:border-white/[0.06] dark:bg-white/[0.03]'
                >
                  <div className='flex items-center gap-2'>
                    <span className='text-sm font-medium text-slate-800 dark:text-slate-100'>
                      {volume.name}
                    </span>
                    <span
                      className={clsx(
                        'rounded-md px-1.5 py-0.5 text-[10px]',
                        volume.writable
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                      )}
                    >
                      {volume.writable ? '可写' : '不可写'}
                    </span>
                    <span className='ml-auto text-[11px] text-slate-400'>
                      {formatBytes(volume.freeBytes)} 可用
                    </span>
                  </div>
                  <div className='mt-1 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400'>
                    {volume.path}
                  </div>
                  <div className='mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/[0.08]'>
                    <div
                      className='h-full rounded-full bg-gradient-to-r from-primary-400 to-indigo-500'
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {volumes.length === 0 && (
              <div className='rounded-2xl border border-dashed border-slate-300 p-4 text-center text-xs text-slate-400 dark:border-white/10'>
                没有配置存储盘，请在服务端 data 目录的 volumes.json 中添加。
              </div>
            )}
          </div>
        </div>

        <div className='glass-card p-5 order-6'>
          <div className='flex items-center gap-2'>
            <MdLockOutline className='text-primary-500' size={20} />
            <div className='text-base font-semibold text-slate-900 dark:text-white'>访问控制</div>
          </div>
          <div className='mt-4 flex items-start justify-between gap-4 rounded-2xl bg-slate-100/70 p-3 dark:bg-white/[0.04]'>
            <div>
              <div className='text-sm font-medium text-slate-800 dark:text-slate-100'>
                只允许内网登录
              </div>
              <div className='mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400'>
                默认开启。开启后只有局域网/内网 IP 可以登录，公网请求会被拒绝；如需公网访问，请先从内网登录后关闭，并配置 HTTPS 与额外认证。
              </div>
            </div>
            <Switch
              isSelected={lanOnly}
              onValueChange={(value) => void toggleLanOnly(value)}
              aria-label='只允许内网登录'
            />
          </div>
        </div>

      </div>

      <ConfirmDialog
        open={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        title='退出夸克账号'
        description='退出后会删除本地保存的登录 Cookie。网盘中的文件不会被删除。'
        confirmLabel='退出'
        danger
        onConfirm={async () => {
          if (!activeAccount) return;
          await logout(activeAccount.id);
        }}
      />

      <StorageBrowser
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        initialPath={settings?.downloadDir}
        title='设置默认下载文件夹'
        confirmLabel='设为默认'
        onSelect={(path) => void setDefaultDir(path)}
      />
    </div>
  );
}
