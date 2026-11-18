import { MdOutlineCloudUpload } from 'react-icons/md';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className='flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-slate-200 px-6 py-16 text-center dark:border-white/[0.08]'>
      <div className='flex h-16 w-16 items-center justify-center rounded-3xl bg-primary-50 text-primary-400 dark:bg-primary-500/10 dark:text-primary-300'>
        <MdOutlineCloudUpload size={32} />
      </div>
      <div className='text-base font-semibold text-slate-700 dark:text-slate-200'>{title}</div>
      {description && (
        <div className='max-w-md text-sm text-slate-500 dark:text-slate-400'>{description}</div>
      )}
      {action}
    </div>
  );
}
