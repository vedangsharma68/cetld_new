"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../ui/button";
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-950/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl">
          <Dialog.Title className="text-xl font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="my-4 text-sm text-slate-600">
            {description}
          </Dialog.Description>
          <div className="flex justify-end gap-3">
            <Dialog.Close asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              variant="destructive"
              onClick={onConfirm}
              disabled={pending}
            >
              {pending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
