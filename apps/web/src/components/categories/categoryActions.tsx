import { useState, type ReactNode } from 'react';
import { categoryHues, type Category } from '../../lib/categories';
import { useServices } from '../../lib/services/react';
import { DeleteOutlineIcon, EditIcon, type IconProps } from '../icons';
import { ConfirmDialog, type MenuItem } from '../overlay';
import { useToast } from '../toast';
import { useCategoryContents } from './model';

/**
 * Deleting a category, after asking. Its items are kept and go back to the
 * Library home; a deleted category cannot come back, so there is no undo.
 */
export function useDeleteCategory(onDeleted?: (category: Category) => void): { ask: (category: Category) => void; dialog: ReactNode } {
  const services = useServices();
  const toast = useToast();
  const contents = useCategoryContents();
  const [target, setTarget] = useState<Category | null>(null);
  const [open, setOpen] = useState(false);
  const count = target ? (contents.items.get(target.id)?.length ?? 0) : 0;
  const body =
    count === 0
      ? 'It has nothing in it. This removes it from all your devices.'
      : `${count === 1 ? 'Its one item goes' : `Its ${count} items go`} back to your Library. Nothing is removed from this device.`;
  const dialog = (
    <ConfirmDialog
      open={open}
      title={target ? `Delete “${target.name}”?` : 'Delete category?'}
      body={body}
      cancelLabel="Keep"
      confirmLabel="Delete"
      danger
      onCancel={() => setOpen(false)}
      onConfirm={() => {
        setOpen(false);
        if (!target) return;
        void services.categories.remove(target.id).then(
          () => {
            toast.show(`Deleted ${target.name}`);
            onDeleted?.(target);
          },
          (e: unknown) => toast.show(e instanceof Error && e.message ? e.message : "Couldn't delete the category."),
        );
      }}
    />
  );
  return {
    ask: (category) => {
      setTarget(category);
      setOpen(true);
    },
    dialog,
  };
}

/** A menu icon that is the category's colour dot. */
function dotIcon(category: Category) {
  const Dot = ({ size = 16 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5" fill={categoryHues[category.color]} />
    </svg>
  );
  return Dot;
}

/** The actions on a category: its bookcase tile's menu and the category view's ⋯. */
export function categoryActions(
  category: Category,
  handlers: { edit: (category: Category, focus: 'name' | 'color') => void; askDelete: (category: Category) => void; open?: () => void },
): MenuItem[] {
  const items: MenuItem[] = [];
  if (handlers.open) items.push({ label: 'Open', onSelect: handlers.open });
  items.push(
    { label: 'Rename…', icon: EditIcon, onSelect: () => handlers.edit(category, 'name') },
    { label: 'Change colour…', icon: dotIcon(category), onSelect: () => handlers.edit(category, 'color') },
    { label: 'Delete category…', icon: DeleteOutlineIcon, danger: true, separated: true, onSelect: () => handlers.askDelete(category) },
  );
  return items;
}
