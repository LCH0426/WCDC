import { Button } from '@heroui/button';
import { useEffect } from 'react';
import { MdOutlineQrCode2 } from 'react-icons/md';
import { useLocation } from 'react-router-dom';

import { useApp } from '@/context/app';

export function QuarkGate({ children }: { children: React.ReactNode }) {
  const { accounts, openQuarkLogin } = useApp();
  const location = useLocation();

  useEffect(() => {
    if (accounts.length === 0) {
      openQuarkLogin(location.pathname);
    }
  }, [accounts.length, location.pathname, openQuarkLogin]);

  if (accounts.length > 0) {
    return <>{children}</>;
  }

  return (
    <div className='glass-card flex min-h-[360px] flex-col items-center justify-center gap-4 p-8 text-center'>
      <div className='flex h-14 w-14 items-center justify-center rounded-3xl bg-primary/10 text-primary'>
        <MdOutlineQrCode2 size={30} />
      </div>
      <div>
        <div className='text-lg font-semibold text-slate-900 dark:text-white'>
          需要绑定夸克账号
        </div>
        <div className='mt-1 text-sm text-slate-500 dark:text-slate-400'>
          服务器功能可以继续使用；夸克网盘功能需要扫码登录后才会加载。
        </div>
      </div>
      <Button
        color='primary'
        radius='full'
        startContent={<MdOutlineQrCode2 size={18} />}
        onPress={() => openQuarkLogin(location.pathname)}
      >
        扫码绑定夸克
      </Button>
    </div>
  );
}
