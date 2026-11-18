import { Button } from '@heroui/button';
import { Input } from '@heroui/input';
import { Spinner } from '@heroui/spinner';
import clsx from 'clsx';
import { useState } from 'react';
import {
  MdLockOutline,
  MdVisibility,
  MdVisibilityOff,
} from 'react-icons/md';
import toast from 'react-hot-toast';

import { PageBackground } from '@/components/PageBackground';
import { useAuth } from '@/context/auth';
import { APP_BASE } from '@/lib/base';

export default function AuthPage() {
  const { status, register, login } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!status) {
    return (
      <div className='relative flex min-h-screen items-center justify-center'>
        <PageBackground />
        <Spinner color='primary' label='正在检查登录状态…' />
      </div>
    );
  }

  if (status.lanAllowed === false) {
    return (
      <div className='relative flex min-h-screen items-center justify-center overflow-hidden px-4'>
        <PageBackground />
        <div className='glass-card w-full max-w-[380px] p-7 text-center'>
          <div className='mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10 text-danger'>
            <MdLockOutline size={26} />
          </div>
          <div className='mt-3 text-lg font-bold text-slate-900 dark:text-white'>
            当前网络不允许登录
          </div>
          <div className='mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400'>
            “只允许内网登录”已开启，请从局域网/内网地址访问；如需公网访问，请先从内网登录后在设置中关闭该选项。
          </div>
        </div>
      </div>
    );
  }

  const registerMode = !status.registered;

  const submit = async () => {
    setError('');
    if (password.length < 8 || password.length > 128) {
      setError('访问密码长度需为 8-128 位');
      return;
    }
    if (registerMode && password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      if (registerMode) {
        await register(password);
        toast.success('访问密码已设置');
      } else {
        await login(password);
        toast.success('登录成功');
      }
      const serverPaths = ['/server-files', '/downloads', '/logs', '/settings'];
      const current = window.location.pathname;
      const relative =
        APP_BASE && current.startsWith(`${APP_BASE}/`)
          ? current.slice(APP_BASE.length)
          : current;
      const target = serverPaths.includes(relative) ? relative : '/downloads';
      // Full reload also guarantees the newest SPA bundle is used after a
      // password login instead of a stale cached page.
      window.location.replace(`${APP_BASE}${target}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className='relative flex min-h-screen items-center justify-center overflow-hidden px-4'>
      <PageBackground />
      <div className='animate-float-in glass-card w-full max-w-[380px] p-7'>
        <div className='text-center'>
          <div className='mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary'>
            <MdLockOutline size={26} />
          </div>
          <div className='mt-3 text-lg font-bold text-slate-900 dark:text-white'>
            {registerMode ? '设置访问密码' : '登录'}
          </div>
          <div className='mt-1 text-xs text-slate-500 dark:text-slate-400'>
            {registerMode
              ? '首次使用，请设置唯一的访问密码'
              : '输入访问密码后使用全部功能'}
          </div>
        </div>

        <div className='mt-6 space-y-3'>
          <Input
            autoFocus
            type={showPassword ? 'text' : 'password'}
            label='访问密码'
            placeholder='至少 8 位'
            value={password}
            onValueChange={setPassword}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
            endContent={
              <button
                type='button'
                className='text-slate-400 transition hover:text-primary'
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <MdVisibilityOff size={19} /> : <MdVisibility size={19} />}
              </button>
            }
          />
          {registerMode && (
            <Input
              type={showPassword ? 'text' : 'password'}
              label='确认密码'
              placeholder='再次输入访问密码'
              value={confirm}
              onValueChange={setConfirm}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
            />
          )}
          {error && (
            <div className='rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger'>
              {error}
            </div>
          )}
          <Button
            className={clsx('w-full', busy && 'cursor-wait')}
            color='primary'
            radius='full'
            isLoading={busy}
            onPress={() => void submit()}
          >
            {registerMode ? '注册并进入' : '登录'}
          </Button>
        </div>

        <div className='mt-4 text-center text-[11px] text-slate-400'>
          只有一个访问密码，没有用户名；密码使用 Argon2id 哈希保存
        </div>
      </div>
    </div>
  );
}
