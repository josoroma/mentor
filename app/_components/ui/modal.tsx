'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Modal = ({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  onCloseAutoFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children: React.ReactNode
  className?: string
  onCloseAutoFocus?: React.ComponentProps<typeof Dialog.Content>['onCloseAutoFocus']
}) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay" />
      <Dialog.Content
        className={cn('modal-content', className)}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <Dialog.Title className="modal-title">{title}</Dialog.Title>
        <Dialog.Description className="modal-description">{description}</Dialog.Description>
        <Dialog.Close className="modal-close" aria-label="Close dialog">
          <X size={20} />
        </Dialog.Close>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
)
