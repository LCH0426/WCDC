import { Button } from '@heroui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/modal';
import { useEffect, useState } from 'react';

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel = '确认',
  danger = false,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} size='md' backdrop='blur'>
      <ModalContent>
        <ModalHeader className='text-lg'>{title}</ModalHeader>
        {description ? (
          <ModalBody className='text-sm text-slate-600 dark:text-slate-300'>
            {description}
          </ModalBody>
        ) : (
          <ModalBody />
        )}
        <ModalFooter>
          <Button variant='light' onPress={onClose} isDisabled={busy}>
            取消
          </Button>
          <Button
            color={danger ? 'danger' : 'primary'}
            isLoading={busy}
            onPress={() => void handleConfirm()}
          >
            {confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
