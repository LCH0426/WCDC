import { Avatar } from '@heroui/avatar';
import { Button } from '@heroui/button';
import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
} from '@heroui/dropdown';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import {
  MdAdd,
  MdArticle,
  MdChevronRight,
  MdDarkMode,
  MdDeleteOutline,
  MdDownloadDone,
  MdFolderOpen,
  MdLightMode,
  MdLockOutline,
  MdLogout,
  MdMovieFilter,
  MdOutlineDownload,
  MdOutlineRefresh,
  MdSettings,
  MdStorage,
  MdTerminal,
} from 'react-icons/md';
import { NavLink } from 'react-router-dom';
import toast from 'react-hot-toast';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useApp } from '@/context/app';
import { useAuth } from '@/context/auth';
import { formatBytes, formatExpire } from '@/lib/format';

const navSections: {
  title: string;
  items: {
    label: string;
    href: string;
    icon: typeof MdFolderOpen;
    requiresQuark?: boolean;
  }[];
}[] = [
  {
    title: '夸克网盘',
    items: [
      { label: '全部文件', href: '/quark', icon: MdFolderOpen, requiresQuark: true },
      {
        label: '传输中心',
        href: '/transfers',
        icon: MdOutlineDownload,
        requiresQuark: true,
      },
      { label: '回收站', href: '/recycle', icon: MdDeleteOutline, requiresQuark: true },
    ],
  },
  {
    title: '服务器',
    items: [
      { label: '服务器文件', href: '/server-files', icon: MdStorage },
      { label: '已下载文件', href: '/downloads', icon: MdDownloadDone },
      { label: '转码', href: '/transcode', icon: MdMovieFilter },
      { label: '终端', href: '/terminal', icon: MdTerminal },
      { label: '日志', href: '/logs', icon: MdArticle },
      { label: '设置', href: '/settings', icon: MdSettings },
    ],
  },
];

export function Sidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    accounts,
    settings,
    activeAccount,
    activeAccountId,
    setActiveAccountId,
    logout,
    refreshAccount,
    theme,
    setTheme,
    openQuarkLogin,
  } = useApp();
  const { logout: logoutSite } = useAuth();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const fnosMode = settings?.fnosMode === true;
  const visibleSections = navSections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          !(fnosMode && (item.href === '/server-files' || item.href === '/terminal'))
      ),
    }))
    .filter((section) => section.items.length > 0);

  const usedPercent = activeAccount?.totalSpace
    ? Math.min(100, (activeAccount.usedSpace / activeAccount.totalSpace) * 100)
    : 0;

  const handleAccountAction = async (key: string) => {
    if (!activeAccount) return;
    if (key === 'add') {
      openQuarkLogin('/quark');
      return;
    }
    if (key === 'refresh') {
      try {
        await refreshAccount(activeAccount.id);
        toast.success('账号信息已刷新');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '刷新失败');
      }
      return;
    }
    if (key === 'logout') {
      setLogoutOpen(true);
      return;
    }
    if (key !== activeAccount.id) {
      setActiveAccountId(key);
    }
  };

  return (
    <>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className='fixed inset-y-0 left-64 right-0 z-40 bg-black/20 backdrop-blur-[1px] md:hidden'
            aria-hidden='true'
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.2, delay: 0.15 }}
          />
        )}
      </AnimatePresence>

      <motion.aside
        className={clsx(
          'fixed left-0 top-0 z-50 h-full overflow-hidden rounded-r-2xl md:static md:rounded-none',
          'bg-content1/70 shadow-xl backdrop-blur-xl backdrop-saturate-150',
          'md:bg-transparent md:shadow-none md:backdrop-blur-none md:backdrop-saturate-100'
        )}
        initial={{ width: 0 }}
        animate={{ width: open ? '16rem' : 0 }}
        transition={{
          type: open ? 'spring' : 'tween',
          stiffness: 150,
          damping: open ? 15 : 10,
        }}
      >
        <div className='relative z-30 flex h-full w-64 flex-col items-stretch p-4'>
          <div className='my-8 ml-2 flex items-center justify-start gap-3 px-2'>
            <div className='h-5 w-1 rounded-full bg-primary shadow-sm' />
            <div className='select-none text-xl font-bold tracking-wide text-default-900 dark:text-white'>
              WCDC
            </div>
            <button
              type='button'
              onClick={onClose}
              className='ml-auto rounded-full p-1.5 text-slate-400 transition hover:bg-default-100 md:hidden dark:hover:bg-white/[0.06]'
              aria-label='关闭侧边栏'
            >
              <MdChevronRight className='rotate-180' size={20} />
            </button>
          </div>

          <div className='flex flex-1 flex-col overflow-y-auto px-2'>
            {visibleSections.map((section) => (
              <div key={section.title} className='mb-2'>
                <div className='px-3 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500'>
                  {section.title}
                </div>
                <nav className='flex flex-col gap-1.5'>
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <NavLink
                        key={item.href}
                        to={item.href}
                        end={item.href === '/quark'}
                        onClick={(event) => {
                          if (window.innerWidth < 768) onClose();
                          if (item.requiresQuark && accounts.length === 0) {
                            event.preventDefault();
                            openQuarkLogin(item.href);
                          }
                        }}
                        className={({ isActive }) =>
                          clsx(
                            'flex w-full items-center justify-start rounded-full px-3 py-2.5 text-left transition-all duration-300',
                            isActive
                              ? 'translate-x-1 bg-primary/10 font-semibold text-primary shadow-none dark:bg-primary/20 dark:text-primary-400'
                              : 'text-slate-600 hover:translate-x-1 hover:bg-default-100 dark:text-slate-200 dark:hover:bg-white/[0.06]'
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <Icon size={20} />
                            <span className='ml-3 text-[15px]'>{item.label}</span>
                            <span
                              className={clsx(
                                'ml-auto h-1.5 w-3 rounded-full shadow-lg',
                                isActive
                                  ? 'bg-primary-500'
                                  : 'bg-primary-200 dark:bg-white/70'
                              )}
                            />
                          </>
                        )}
                      </NavLink>
                    );
                  })}
                </nav>
              </div>
            ))}

            <div className='mt-auto mb-2 space-y-3 px-1 pt-6'>
              {activeAccount ? (
                <div className='rounded-2xl border border-white/50 bg-white/40 p-3 shadow-sm backdrop-blur-sm dark:border-white/[0.06] dark:bg-white/[0.04]'>
                  <Dropdown placement='top-start'>
                    <DropdownTrigger>
                      <button
                        type='button'
                        className='flex w-full items-center gap-2.5 rounded-xl p-1 text-left transition hover:bg-white/60 dark:hover:bg-white/[0.05]'
                      >
                        <Avatar
                          size='sm'
                          src={activeAccount.avatarUrl || undefined}
                          name={activeAccount.nickname.slice(0, 1) || 'Q'}
                          className='shrink-0 bg-primary text-white'
                        />
                        <div className='min-w-0 flex-1'>
                          <div className='flex items-center gap-1.5'>
                            <span className='truncate text-sm font-semibold text-slate-800 dark:text-slate-100'>
                              {activeAccount.nickname || '夸克用户'}
                            </span>
                            {activeAccount.isVip && (
                              <span className='rounded-md bg-gradient-to-r from-amber-400 to-orange-500 px-1.5 py-0.5 text-[10px] font-bold text-white'>
                                VIP
                              </span>
                            )}
                          </div>
                          <div className='truncate text-[11px] text-slate-500 dark:text-slate-400'>
                            {formatBytes(activeAccount.usedSpace)} /{' '}
                            {formatBytes(activeAccount.totalSpace)}
                          </div>
                        </div>
                        <MdChevronRight className='rotate-90 text-slate-400' size={18} />
                      </button>
                    </DropdownTrigger>
                    <DropdownMenu
                      aria-label='账号菜单'
                      onAction={(key) => void handleAccountAction(String(key))}
                    >
                      <DropdownSection showDivider>
                        {accounts.map((account) => (
                          <DropdownItem
                            key={account.id}
                            description={
                              account.id === activeAccountId ? '当前账号' : undefined
                            }
                          >
                            <span className='flex items-center gap-2'>
                              <Avatar
                                size='sm'
                                src={account.avatarUrl || undefined}
                                name={account.nickname.slice(0, 1) || 'Q'}
                                className='h-6 w-6 bg-primary text-white'
                              />
                              {account.nickname || '夸克用户'}
                            </span>
                          </DropdownItem>
                        ))}
                      </DropdownSection>
                      <DropdownSection>
                        <DropdownItem key='add' startContent={<MdAdd size={18} />}>
                          添加账号
                        </DropdownItem>
                        <DropdownItem
                          key='refresh'
                          startContent={<MdOutlineRefresh size={18} />}
                        >
                          刷新账号信息
                        </DropdownItem>
                        <DropdownItem
                          key='logout'
                          className='text-danger'
                          color='danger'
                          startContent={<MdLogout size={18} />}
                        >
                          退出当前账号
                        </DropdownItem>
                      </DropdownSection>
                    </DropdownMenu>
                  </Dropdown>
                  <div className='mt-2 px-1'>
                    <div className='h-1.5 overflow-hidden rounded-full bg-slate-200/70 dark:bg-white/[0.08]'>
                      <div
                        className='h-full rounded-full bg-gradient-to-r from-primary-300 to-primary transition-all'
                        style={{ width: `${usedPercent}%` }}
                      />
                    </div>
                    {activeAccount.vipExpireAt ? (
                      <div className='mt-1.5 truncate text-[10px] text-slate-400'>
                        {formatExpire(activeAccount.vipExpireAt)}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <button
                  type='button'
                  onClick={() => openQuarkLogin('/quark')}
                  className='flex w-full items-center justify-center gap-2 rounded-full border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-500 transition hover:border-primary-400 hover:text-primary dark:border-white/10 dark:text-slate-400'
                >
                  <MdAdd size={18} /> 扫码登录夸克
                </button>
              )}

              <Button
                className='w-full rounded-full bg-primary-50/50 font-medium text-primary-600 shadow-sm backdrop-blur-sm transition-all duration-300 hover:bg-primary-100/80 hover:shadow-md'
                radius='full'
                variant='flat'
                onPress={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                startContent={
                  theme === 'dark' ? <MdLightMode size={18} /> : <MdDarkMode size={18} />
                }
              >
                切换主题
              </Button>
              <Button
                className='mb-1 w-full rounded-full bg-danger-50/50 font-medium text-danger-500 shadow-sm backdrop-blur-sm transition-all duration-300 hover:bg-danger-100/80 hover:shadow-md'
                radius='full'
                variant='flat'
                onPress={() => setLogoutOpen(true)}
                isDisabled={!activeAccount}
                startContent={<MdLogout size={18} />}
              >
                退出夸克账号
              </Button>
              <Button
                className='mb-2 w-full rounded-full bg-default-100/60 font-medium text-default-600 shadow-sm backdrop-blur-sm transition-all duration-300 hover:bg-default-200/80 hover:shadow-md dark:text-default-300'
                radius='full'
                variant='flat'
                onPress={() => void logoutSite()}
                startContent={<MdLockOutline size={18} />}
              >
                退出系统
              </Button>
            </div>
          </div>
        </div>
      </motion.aside>

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
    </>
  );
}
