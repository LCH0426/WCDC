import { Button } from '@heroui/button';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import {
  MdClearAll,
  MdLockOutline,
  MdOutlineRefresh,
  MdTerminal,
} from 'react-icons/md';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useApp } from '@/context/app';
import { APP_BASE } from '@/lib/base';

type TerminalStatus = 'connecting' | 'connected' | 'closed' | 'error';

const STATUS: Record<
  TerminalStatus,
  { label: string; className: string }
> = {
  connecting: { label: '连接中', className: 'bg-warning/10 text-warning' },
  connected: { label: '已连接', className: 'bg-success/10 text-success' },
  closed: { label: '已断开', className: 'bg-default-100 text-default-500' },
  error: { label: '连接失败', className: 'bg-danger/10 text-danger' },
};

function xtermTheme(dark: boolean) {
  return {
    background: dark ? '#0b0b0d' : '#fafafa',
    foreground: dark ? '#e5e7eb' : '#1f2937',
    cursor: '#f472b6',
    cursorAccent: dark ? '#0b0b0d' : '#fafafa',
    selectionBackground: dark ? '#3f3f46' : '#fbcfe8',
  };
}

export default function TerminalPage() {
  const { settings, theme, saveSettings } = useApp();
  const enabled = settings?.lanOnly === true;
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [shell, setShell] = useState('');
  const [connectionKey, setConnectionKey] = useState(0);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const themeRef = useRef(theme);

  useEffect(() => {
    themeRef.current = theme;
    if (termRef.current) {
      termRef.current.options.theme = xtermTheme(theme === 'dark');
    }
  }, [theme]);

  useEffect(() => {
    if (!enabled) return;
    const host = hostRef.current;
    if (!host) return;

    setStatus('connecting');
    setShell('');

    const term = new XTerm({
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: xtermTheme(themeRef.current === 'dark'),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(
      `${protocol}//${window.location.host}${APP_BASE}/api/terminal/ws`
    );
    socket.binaryType = 'arraybuffer';
    let disposed = false;
    let ended = false;

    const sendResize = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })
        );
      }
    };
    const fitTerminal = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      sendResize();
    };
    const encoder = new TextEncoder();
    const dataSubscription = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encoder.encode(data));
      }
    });
    const resizeSubscription = term.onResize(() => sendResize());
    const observer = new ResizeObserver(() => fitTerminal());
    observer.observe(host);
    const frame = requestAnimationFrame(fitTerminal);

    socket.onopen = () => {
      if (disposed) return;
      setStatus('connected');
      fitTerminal();
      term.focus();
    };
    socket.onmessage = (event) => {
      if (disposed) return;
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
        return;
      }
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as {
          type?: string;
          shell?: string;
          message?: string;
        };
        if (message.type === 'hello') {
          setShell(message.shell ?? '');
        } else if (message.type === 'error') {
          setStatus('error');
          ended = true;
          term.writeln(`\r\n\x1b[31m${message.message ?? '终端错误'}\x1b[0m`);
        } else if (message.type === 'exit') {
          setStatus('closed');
          ended = true;
          term.writeln('\r\n\x1b[33m[会话已结束]\x1b[0m');
        }
      } catch {
        // Ignore non-JSON control frames.
      }
    };
    socket.onerror = () => {
      if (disposed) return;
      setStatus('error');
      if (!ended) {
        ended = true;
        term.writeln(
          '\r\n\x1b[31m[连接失败] 请确认已开启“只允许内网访问”，并从内网访问本站。\x1b[0m'
        );
      }
    };
    socket.onclose = () => {
      if (disposed) return;
      if (!ended) setStatus('closed');
      if (!ended) {
        ended = true;
        term.writeln('\r\n\x1b[33m[连接已断开]\x1b[0m');
      }
    };

    term.focus();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      dataSubscription.dispose();
      resizeSubscription.dispose();
      socket.onclose = null;
      socket.close();
      term.dispose();
      termRef.current = null;
    };
  }, [enabled, connectionKey]);

  const enableLanOnly = async () => {
    setEnabling(true);
    try {
      await saveSettings({ lanOnly: true });
      toast.success('已开启只允许内网访问，终端已启用');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '开启内网限制失败'
      );
    } finally {
      setEnabling(false);
    }
  };

  const meta = STATUS[status];

  return (
    <div className='animate-float-in space-y-4'>
      <div className='glass-card p-4'>
        <div className='flex flex-wrap items-start gap-3'>
          <div className='flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary'>
            <MdTerminal size={24} />
          </div>
          <div className='min-w-0 flex-1'>
            <div className='flex flex-wrap items-center gap-2'>
              <h2 className='text-lg font-semibold text-slate-900 dark:text-white'>
                终端
              </h2>
              {enabled && (
                <span
                  className={clsx(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    meta.className
                  )}
                >
                  {meta.label}
                </span>
              )}
              {enabled && shell && (
                <span className='rounded-full bg-default-100 px-2 py-0.5 text-[11px] text-default-600 dark:bg-white/[0.06] dark:text-default-300'>
                  {shell}
                </span>
              )}
            </div>
            <p className='mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400'>
              终端以服务进程用户身份运行，拥有该用户的文件与系统权限。仅限在受信任的内网使用，并且必须开启“只允许内网访问”。
            </p>
          </div>
          {enabled && (
            <div className='flex flex-wrap gap-2'>
              <Button
                size='sm'
                variant='flat'
                startContent={<MdClearAll size={16} />}
                onPress={() => termRef.current?.clear()}
              >
                清屏
              </Button>
              <Button
                size='sm'
                variant='flat'
                startContent={<MdOutlineRefresh size={16} />}
                onPress={() => setConnectionKey((value) => value + 1)}
              >
                重新连接
              </Button>
            </div>
          )}
        </div>
        <div className='mt-3 rounded-xl bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-warning'>
          注意：终端不是沙箱。登录本站的用户可以通过它执行服务进程权限内的任意命令。
        </div>
      </div>

      {!enabled ? (
        <div className='glass-card p-6'>
          <div className='flex items-start gap-3'>
            <MdLockOutline className='mt-0.5 shrink-0 text-warning' size={24} />
            <div className='min-w-0'>
              <div className='font-semibold text-slate-900 dark:text-white'>
                终端需要开启“只允许内网访问”
              </div>
              <p className='mt-1 text-sm leading-relaxed text-slate-500 dark:text-slate-400'>
                为避免把服务器 shell 暴露到公网，终端只在内网限制开启时可用。开启后，非内网 IP 将无法访问本站任何 API。
              </p>
              <div className='mt-3 flex flex-wrap gap-2'>
                <Button
                  size='sm'
                  color='primary'
                  variant='flat'
                  isLoading={enabling}
                  onPress={() => setConfirmEnable(true)}
                >
                  开启内网限制并启用终端
                </Button>
                <Link
                  to='/settings'
                  className='inline-flex h-8 items-center rounded-full bg-default-100 px-3 text-sm text-slate-600 transition hover:bg-primary/10 hover:text-primary dark:bg-white/[0.06] dark:text-slate-300'
                >
                  前往设置
                </Link>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className='glass-card overflow-hidden p-2'>
          <div
            ref={hostRef}
            className='h-[calc(100vh-280px)] min-h-[420px] w-full overflow-hidden rounded-2xl bg-[#fafafa] p-2 text-left dark:bg-[#0b0b0d]'
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmEnable}
        onClose={() => setConfirmEnable(false)}
        title='开启只允许内网访问'
        description='开启后，公网 IP 将无法访问本站任何 API。终端可以执行服务进程权限内的命令，请确认你仅在受信任的内网使用。'
        confirmLabel='开启并启用终端'
        onConfirm={enableLanOnly}
      />
    </div>
  );
}
