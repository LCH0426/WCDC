import { BreadcrumbItem, Breadcrumbs } from '@heroui/breadcrumbs';
import { Button } from '@heroui/button';
import { AnimatePresence, motion } from 'framer-motion';
import { MdMenu, MdMenuOpen } from 'react-icons/md';

export function PageTopBar({
  title,
  onToggleSidebar,
  sidebarOpen,
}: {
  title: string;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}) {
  return (
    <div className='sticky left-0 top-2 z-30 m-2 mb-0 flex h-10 items-center rounded-full bg-background/50 text-xl font-bold shadow-sm shadow-primary-50 backdrop-blur-lg dark:bg-background dark:shadow-primary-100'>
      <div className='relative z-50 ml-0 mr-1 md:relative md:z-auto md:!ml-0 md:pl-0'>
        <Button
          isIconOnly
          radius='full'
          variant='light'
          onPress={onToggleSidebar}
          aria-label='切换侧边栏'
        >
          {sidebarOpen ? <MdMenuOpen size={24} /> : <MdMenu size={24} />}
        </Button>
      </div>
      <Breadcrumbs isDisabled size='lg'>
        <BreadcrumbItem>
          <AnimatePresence mode='wait'>
            <motion.div
              key={title}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.3 }}
            >
              {title}
            </motion.div>
          </AnimatePresence>
        </BreadcrumbItem>
      </Breadcrumbs>
    </div>
  );
}
