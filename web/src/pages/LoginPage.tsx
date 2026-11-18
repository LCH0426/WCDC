import { Button } from '@heroui/button';
import { Spinner } from '@heroui/spinner';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MdRefresh } from 'react-icons/md';
import { QRCodeSVG } from 'qrcode.react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

import { PageBackground } from '@/components/PageBackground';
import { useApp } from '@/context/app';
import { api } from '@/lib/api';
import type { QrLoginStart } from '@/lib/types';

export default function LoginPage() {
  const navigate = useNavigate();
  const { refresh } = useApp();
  const [session, setSession] = useState<QrLoginStart | null>(null);
  const [state, setState] = useState<'loading' | 'waiting' | 'expired' | 'success' | 'error'>(
    'loading'
  );
  const [message, setMessage] = useState('');
  const polling = useRef(false);

  const start = useCallback(async () => {
    setState('loading');
    setMessage('');
    try {
      const next = await api.startQrLogin();
      setSession(next);
      setState('waiting');
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : '获取二维码失败');
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (!session || state !== 'waiting') return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const result = await api.pollQrLogin(session.sessionId);
        if (cancelled) return;
        if (result.state === 'success') {
          setState('success');
          setMessage(result.message ?? '登录成功');
          toast.success(`登录成功：${result.account?.nickname ?? '夸克账号'}`);
          await refresh();
          window.setTimeout(() => navigate('/quark'), 350);
        } else if (result.state === 'expired') {
          setState('expired');
          setMessage(result.message ?? '二维码已过期');
        }
      } catch (error) {
        if (!cancelled) {
          setState('error');
          setMessage(error instanceof Error ? error.message : '查询扫码状态失败');
        }
      } finally {
        polling.current = false;
      }
    }, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session, state, refresh, navigate]);

  useEffect(() => {
    return () => {
      if (session) void api.cancelQrLogin(session.sessionId).catch(() => undefined);
    };
  }, [session]);

  return (
    <div className='relative flex min-h-screen items-center justify-center overflow-hidden px-4'>
      <PageBackground />
      <div className='animate-float-in glass-card w-full max-w-[360px] p-6'>
        <div className='text-center'>
          <div className='text-lg font-bold text-slate-900 dark:text-white'>扫码登录</div>
          <div className='mt-1 text-xs text-slate-500 dark:text-slate-400'>
            使用夸克 App 扫描二维码
          </div>
        </div>

        <div className='relative mx-auto mt-5 w-fit'>
          <div className='relative flex h-[236px] w-[236px] items-center justify-center overflow-hidden rounded-3xl bg-white p-5 shadow-inner'>
            {session?.qrUrl && state !== 'error' ? (
              <QRCodeSVG value={session.qrUrl} size={196} level='M' />
            ) : (
              <Spinner color='primary' />
            )}
            {(state === 'loading' || state === 'success') && (
              <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-3xl bg-white/90 backdrop-blur'>
                <Spinner color='primary' />
                <span className='text-xs text-slate-500'>
                  {state === 'success' ? '登录成功，正在进入网盘…' : '正在获取二维码…'}
                </span>
              </div>
            )}
            {state === 'expired' && (
              <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-3xl bg-white/90 backdrop-blur'>
                <div className='text-sm font-medium text-slate-700'>二维码已过期</div>
                <Button
                  size='sm'
                  color='primary'
                  startContent={<MdRefresh size={16} />}
                  onPress={() => void start()}
                >
                  刷新二维码
                </Button>
              </div>
            )}
            {state === 'error' && (
              <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-3xl bg-white/92 p-5 text-center backdrop-blur'>
                <div className='text-sm font-medium text-danger'>获取二维码失败</div>
                <div className='max-h-16 overflow-hidden text-[11px] leading-5 text-slate-500'>
                  {message}
                </div>
                <Button size='sm' color='primary' onPress={() => void start()}>
                  重试
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className='mt-4 text-center text-sm'>
          {state === 'waiting' && (
            <span className='text-slate-500 dark:text-slate-400'>等待扫码确认…</span>
          )}
          {state === 'success' && (
            <span className='text-success'>{message || '登录成功'}</span>
          )}
          {state === 'error' && <span className='text-danger'>{message}</span>}
          {state === 'expired' && (
            <span className='text-amber-500'>二维码已失效，请刷新后重试</span>
          )}
        </div>

        <div className='mt-4 flex justify-center'>
          <Button
            size='sm'
            radius='full'
            variant='flat'
            startContent={<MdRefresh size={16} />}
            onPress={() => void start()}
            isDisabled={state === 'loading' || state === 'success'}
          >
            换一张
          </Button>
        </div>
      </div>
    </div>
  );
}
