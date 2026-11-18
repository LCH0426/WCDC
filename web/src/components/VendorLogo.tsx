import clsx from 'clsx';

import amdLogo from '@/assets/vendors/amd.svg';
import intelLogo from '@/assets/vendors/intel.svg';
import nvidiaLogo from '@/assets/vendors/nvidia.svg';

const LOGOS: Record<string, { src: string; label: string }> = {
  intel: { src: intelLogo, label: 'Intel' },
  amd: { src: amdLogo, label: 'AMD' },
  nvidia: { src: nvidiaLogo, label: 'NVIDIA' },
};

const SIZES = {
  xs: { box: 'px-1 py-0.5', img: 'h-2.5' },
  sm: { box: 'px-1.5 py-0.5', img: 'h-3.5' },
  md: { box: 'px-2 py-1', img: 'h-5' },
} as const;

export function VendorLogo({
  vendor,
  size = 'sm',
  className,
}: {
  vendor: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const logo = LOGOS[vendor];
  if (!logo) return null;
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-md bg-white shadow-sm ring-1 ring-black/5',
        SIZES[size].box,
        className
      )}
    >
      <img
        src={logo.src}
        alt={logo.label}
        loading='lazy'
        className={clsx('w-auto', SIZES[size].img)}
      />
    </span>
  );
}
