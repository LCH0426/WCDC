import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { Spinner } from '@heroui/spinner';
import { MdCloudQueue } from 'react-icons/md';
import { Toaster } from 'react-hot-toast';

import App from './App';
import { APP_BASE } from './lib/base';
import AuthPage from './pages/AuthPage';
import { AppProvider, useApp } from './context/app';
import { AuthProvider, useAuth } from './context/auth';
import { Provider } from './provider';
import './styles/globals.css';

function Splash({ label }: { label: string }) {
  return (
    <div className='flex h-screen flex-col items-center justify-center gap-4'>
      <div className='flex h-14 w-14 items-center justify-center rounded-3xl bg-gradient-to-br from-primary-300 to-primary text-white shadow-xl shadow-primary-500/30'>
        <MdCloudQueue size={30} />
      </div>
      <Spinner color='primary' />
      <div className='text-sm text-slate-500 dark:text-slate-400'>{label}</div>
    </div>
  );
}

function ThemedToaster() {
  const { theme } = useApp();
  return (
    <Toaster
      position='top-center'
      toastOptions={{
        style: {
          borderRadius: '20px',
          background: theme === 'dark' ? '#333' : '#fff',
          color: theme === 'dark' ? '#fff' : '#333',
          maxWidth: '400px',
          wordBreak: 'break-word',
        },
      }}
    />
  );
}

function Root() {
  const { status } = useAuth();
  if (!status) return <Splash label='正在检查登录状态…' />;
  if (!status.authenticated) {
    return (
      <>
        <AuthPage />
        <Toaster
          position='top-center'
          toastOptions={{ style: { borderRadius: '20px' } }}
        />
      </>
    );
  }
  return (
    <AppProvider>
      <App />
      <ThemedToaster />
    </AppProvider>
  );
}

const storedTheme = localStorage.getItem('wcdc.theme');
const initialTheme =
  storedTheme === 'light' || storedTheme === 'dark'
    ? storedTheme
    : window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
document.documentElement.classList.toggle('dark', initialTheme === 'dark');
document.documentElement.style.colorScheme = initialTheme;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={APP_BASE || undefined}>
      <Provider>
        <AuthProvider>
          <Root />
        </AuthProvider>
      </Provider>
    </BrowserRouter>
  </React.StrictMode>
);
