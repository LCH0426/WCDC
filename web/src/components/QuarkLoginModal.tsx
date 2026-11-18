import { Button } from '@heroui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/modal';
import { Spinner } from '@heroui/spinner';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MdRefresh } from 'react-icons/md';
import { QRCodeSVG } from 'qrcode.react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

import { useApp } from '@/context/app';
import { api } from '@/lib/api';
import type { QrLoginStart } from '@/lib/types';

export function QuarkLoginModal({
  open,
  nextPath,
  onClose,
}: {
  open: boolean;
  nextPath: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { refresh } = useApp();
  const [session, setSession] = useState<QrLoginStart | null>(null);
  const [state, setState] = useState<
    'loading' | 'waiting' | 'expired' | 'success' | 'error'
  >('loading');
  const [message, setMessage] = useState('');
  const polling = useRef(false);
  const sessionRef = useRef<string | null>(null);

  sessionRef.current = session?.sessionId ?? null;

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
    if (open) void start();
  }, [open, start]);

  useEffect(() => {
    if (!open || !session || state !== 'waiting') return;
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
          toast.success(`夸克账号已绑定：${result.account?.nickname ?? ''}`);
          await refresh();
          onClose();
          if (nextPath) navigate(nextPath, { replace: true });
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
  }, [open, session, state, refresh, navigate, nextPath, onClose]);

  useEffect(() => {
    if (open) return;
    const sessionId = sessionRef.current;
    if (sessionId) void api.cancelQrLogin(sessionId).catch(() => undefined);
    setSession(null);
    setState('loading');
    setMessage('');
  }, [open]);

  return (
    <Modal isOpen={open} onClose={onClose} size='sm' backdrop='blur'>
      <ModalContent>
        <ModalHeader className='text-lg'>绑定夸克账号</ModalHeader>
        <ModalBody>
          <div className='text-center text-xs text-slate-500 dark:text-slate-400'>
            使用夸克 App 扫描二维码，绑定后即可使用夸克网盘功能
          </div>
          <div className='relative mx-auto mt-2 w-fit'>
            <div className='relative flex h-[232px] w-[232px] items-center justify-center overflow-hidden rounded-3xl bg-white p-4 shadow-inner'>
              {session?.qrUrl && state !== 'error' ? (
                <QRCodeSVG value={session.qrUrl} size={196} level='M' />
              ) : (
                <Spinner color='primary' />
              )}
              {(state === 'loading' || state === 'success') && (
                <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-3xl bg-white/90 backdrop-blur'>
                  <Spinner color='primary' />
                  <span className='text-xs text-slate-500'>
                    {state === 'success'
                      ? '登录成功，正在刷新账号…'
                      : '正在获取二维码…'}
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
                <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-3xl bg-white/92 p-4 text-center backdrop-blur'>
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
          <div className='mt-2 text-center text-xs'>
            {state === 'waiting' && (
              <span className='text-slate-500 dark:text-slate-400'>等待扫码确认…</span>
            )}
            {state === 'success' && <span className='text-success'>{message}</span>}
            {state === 'error' && <span className='text-danger'>{message}</span>}
            {state === 'expired' && (
              <span className='text-amber-500'>二维码已失效，请刷新</span>
            )}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant='light' onPress={onClose}>
            取消
          </Button>
          <Button
            variant='flat'
            startContent={<MdRefresh size={16} />}
            onPress={() => void start()}
            isDisabled={state === 'loading' || state === 'success'}
          >
            换一张
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
