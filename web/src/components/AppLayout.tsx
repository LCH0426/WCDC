import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { PageBackground } from '@/components/PageBackground';
import { PageTopBar } from '@/components/PageTopBar';
import { QuarkLoginModal } from '@/components/QuarkLoginModal';
import { Sidebar } from '@/components/Sidebar';
import { useApp } from '@/context/app';

const titles: Record<string, string> = {
  '/quark': '夸克网盘 · 全部文件',
  '/downloads': '已下载文件',
  '/transfers': '传输中心',
  '/server-files': '服务器文件',
  '/transcode': '视频转码',
  '/terminal': '终端',
  '/logs': '日志',
  '/recycle': '回收站',
  '/settings': '设置',
};

export function AppLayout() {
  const location = useLocation();
  const [open, setOpen] = useState(() => window.innerWidth >= 768);
  const { quarkLoginOpen, quarkLoginNext, closeQuarkLogin } = useApp();

  useEffect(() => {
    if (window.innerWidth < 768) setOpen(false);
  }, [location.pathname]);

  const title = titles[location.pathname] ?? '夸克网盘';

  return (
    <div className='relative flex h-screen items-stretch overflow-hidden'>
      <PageBackground />
      <Sidebar open={open} onClose={() => setOpen(false)} />
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
        className='flex-1 overflow-y-auto pb-10 md:pb-0'
      >
        <PageTopBar
          title={title}
          sidebarOpen={open}
          onToggleSidebar={() => setOpen((value) => !value)}
        />
        <main className='mx-auto w-full max-w-[1440px] px-3 py-4 md:px-6 md:py-6'>
          <Outlet />
        </main>
      </motion.div>
      <QuarkLoginModal
        open={quarkLoginOpen}
        nextPath={quarkLoginNext}
        onClose={closeQuarkLogin}
      />
    </div>
  );
}
