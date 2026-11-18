import clsx from 'clsx';
import {
  MdArchive,
  MdDescription,
  MdFolder,
  MdImage,
  MdInsertDriveFile,
  MdMovie,
  MdMusicNote,
} from 'react-icons/md';

import { fileKind } from '@/lib/format';

const palette: Record<
  string,
  { icon: React.ComponentType<{ size?: number; className?: string }>; color: string; bg: string }
> = {
  folder: { icon: MdFolder, color: 'text-amber-500', bg: 'bg-amber-400/15' },
  video: { icon: MdMovie, color: 'text-violet-500', bg: 'bg-violet-400/15' },
  image: { icon: MdImage, color: 'text-pink-500', bg: 'bg-pink-400/15' },
  audio: { icon: MdMusicNote, color: 'text-emerald-500', bg: 'bg-emerald-400/15' },
  doc: { icon: MdDescription, color: 'text-sky-500', bg: 'bg-sky-400/15' },
  archive: { icon: MdArchive, color: 'text-orange-500', bg: 'bg-orange-400/15' },
  file: { icon: MdInsertDriveFile, color: 'text-slate-400', bg: 'bg-slate-400/15' },
};

export function FileIcon({
  name,
  isDir,
  size = 'md',
  className,
}: {
  name: string;
  isDir: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const kind = fileKind(name, isDir);
  const entry = palette[kind] ?? palette.file;
  const Icon = entry.icon;
  return (
    <div
      className={clsx(
        'flex shrink-0 items-center justify-center rounded-2xl',
        entry.bg,
        size === 'sm' && 'h-9 w-9',
        size === 'md' && 'h-11 w-11',
        size === 'lg' && 'h-16 w-16',
        className
      )}
    >
      <Icon
        size={size === 'sm' ? 20 : size === 'md' ? 24 : 34}
        className={entry.color}
      />
    </div>
  );
}
