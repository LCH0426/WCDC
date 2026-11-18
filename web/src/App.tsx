import { Button } from '@heroui/button';
import { Spinner } from '@heroui/spinner';
import { MdCloudQueue, MdRefresh } from 'react-icons/md';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppLayout } from '@/components/AppLayout';
import { QuarkGate } from '@/components/QuarkGate';
import { useApp } from '@/context/app';
import DownloadsPage from '@/pages/DownloadsPage';
import FilesPage from '@/pages/FilesPage';
import LogsPage from '@/pages/LogsPage';
import RecycleBinPage from '@/pages/RecycleBinPage';
import ServerFilesPage from '@/pages/ServerFilesPage';
import SettingsPage from '@/pages/SettingsPage';
import TerminalPage from '@/pages/TerminalPage';
import TranscodePage from '@/pages/TranscodePage';
import TransfersPage from '@/pages/TransfersPage';

function Splash({ label }: { label: string }) {
  return (
    <div className='flex h-screen flex-col items-center justify-center gap-4'>
      <div className='flex h-14 w-14 items-center justify-center rounded-3xl bg-gradient-to-br from-primary-400 to-indigo-600 text-white shadow-xl shadow-primary-500/30'>
        <MdCloudQueue size={30} />
      </div>
      <Spinner color='primary' />
      <div className='text-sm text-slate-500 dark:text-slate-400'>{label}</div>
    </div>
  );
}

export default function App() {
  const { loading, error, refresh, settings } = useApp();
  const fnosMode = settings?.fnosMode === true;

  if (loading) return <Splash label='正在连接服务端…' />;

  if (error) {
    return (
      <div className='flex h-screen flex-col items-center justify-center gap-4 px-6 text-center'>
        <div className='text-lg font-semibold text-slate-800 dark:text-white'>无法连接后端</div>
        <div className='max-w-lg text-sm text-slate-500 dark:text-slate-400'>{error}</div>
        <Button
          color='primary'
          startContent={<MdRefresh size={18} />}
          onPress={() => void refresh()}
        >
          重试
        </Button>
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to='/downloads' replace />} />
        <Route
          path='quark'
          element={
            <QuarkGate>
              <FilesPage />
            </QuarkGate>
          }
        />
        <Route path='downloads' element={<DownloadsPage />} />
        <Route
          path='transfers'
          element={
            <QuarkGate>
              <TransfersPage />
            </QuarkGate>
          }
        />
        <Route
          path='server-files'
          element={fnosMode ? <Navigate to='/downloads' replace /> : <ServerFilesPage />}
        />
        <Route path='transcode' element={<TranscodePage />} />
        <Route path='logs' element={<LogsPage />} />
        <Route
          path='recycle'
          element={
            <QuarkGate>
              <RecycleBinPage />
            </QuarkGate>
          }
        />
        <Route
          path='terminal'
          element={fnosMode ? <Navigate to='/downloads' replace /> : <TerminalPage />}
        />
        <Route path='settings' element={<SettingsPage />} />
        <Route path='*' element={<Navigate to='/downloads' replace />} />
      </Route>
    </Routes>
  );
}
