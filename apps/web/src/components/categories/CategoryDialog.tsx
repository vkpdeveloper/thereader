import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { categoryColors, categoryHues, MAX_CATEGORY_NAME, nextCategoryColor, type Category, type CategoryColor } from '../../lib/categories';
import { useFocusTrap, usePresence } from '../../lib/hooks';
import { cleanCategoryName } from '../../lib/services/categories';
import { useServices, useStore } from '../../lib/services/react';
import { AddIcon, CheckIcon, MoveToFolderIcon, NewFolderIcon, RemoveFromFolderIcon } from '../icons';
import { useOverlayLayer, type MenuItem } from '../overlay';
import { useToast } from '../toast';
import { ShelfScene, hueStyle, type ShelfItem } from './Bookcase';
import { announceFiled, useCategoryContents, type DraggedItem } from './model';

type DialogState =
  /** Filing one item: pick a category, or create one first. */
  | { kind: 'assign'; item: DraggedItem; step: 'pick' | 'create'; fresh?: string }
  /** "New category" from the sidebar or the Library. */
  | { kind: 'create' }
  /** Rename or recolour. */
  | { kind: 'edit'; category: Category; focus: 'name' | 'color' };

export interface CategoryDialogApi {
  /** "Add to…" / "Move to…": the picker, or the create step when there are no categories yet. */
  addTo(item: DraggedItem): void;
  create(): void;
  edit(category: Category, focus?: 'name' | 'color'): void;
  /** Files `item` in a category (null takes it out), with a toast that can undo it. */
  file(item: DraggedItem, categoryId: string | null): Promise<void>;
  /** The category entries of an item's context menu. */
  menuItems(item: DraggedItem): MenuItem[];
  dialog: ReactNode;
}

/** Category dialogs and filing for one screen, like `useContextMenu`. */
export function useCategoryDialog(): CategoryDialogApi {
  const services = useServices();
  const toast = useToast();
  const [state, setState] = useState<DialogState | null>(null);

  const file = useCallback(
    async (item: DraggedItem, categoryId: string | null) => {
      const store = services.categories;
      const before = store.categoryOf(item);
      if ((before?.id ?? null) === categoryId) return;
      try {
        await store.assign(item, categoryId);
      } catch (e) {
        toast.show(e instanceof Error && e.message ? e.message : "Couldn't file that item.");
        return;
      }
      const target = categoryId ? store.getSnapshot().categories.find((c) => c.id === categoryId) : null;
      if (target) announceFiled(target.id);
      const message = target ? `${before ? 'Moved' : 'Added'} to ${target.name}` : `Removed from ${before?.name ?? 'its category'}`;
      toast.show(message, {
        action: {
          label: 'Undo',
          onClick: () => {
            const back = before && store.getSnapshot().categories.some((c) => c.id === before.id) ? before.id : null;
            void store.assign(item, back).catch(() => undefined);
          },
        },
      });
    },
    [services, toast],
  );

  const addTo = useCallback(
    (item: DraggedItem) => {
      const none = services.categories.getSnapshot().categories.length === 0;
      setState({ kind: 'assign', item, step: none ? 'create' : 'pick' });
    },
    [services],
  );
  const create = useCallback(() => setState({ kind: 'create' }), []);
  const edit = useCallback((category: Category, focus: 'name' | 'color' = 'name') => setState({ kind: 'edit', category, focus }), []);

  const menuItems = useCallback(
    (item: DraggedItem): MenuItem[] => {
      const current = services.categories.categoryOf(item);
      if (!current) return [{ label: 'Add to…', icon: NewFolderIcon, onSelect: () => addTo(item) }];
      return [
        { label: 'Move to…', icon: MoveToFolderIcon, onSelect: () => addTo(item) },
        { label: `Remove from ${current.name}`, icon: RemoveFromFolderIcon, onSelect: () => void file(item, null) },
      ];
    },
    [services, addTo, file],
  );

  const dialog = <CategoryDialog state={state} onState={setState} onFile={file} />;
  return { addTo, create, edit, file, menuItems, dialog };
}

// ---------------------------------------------------------------- dialog

/**
 * The category dialog. Filing has two steps in one panel: the picker, and the
 * create step (first, when there are no categories). Creating while filing
 * returns to the picker with the new category selected, so Enter files it.
 */
function CategoryDialog({
  state,
  onState,
  onFile,
}: {
  state: DialogState | null;
  onState: (state: DialogState | null) => void;
  onFile: (item: DraggedItem, categoryId: string | null) => Promise<void>;
}) {
  const services = useServices();
  const { categories } = useStore(services.categories);
  const open = state != null;
  const { mounted, shown } = usePresence(open, 220);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Keeps the content steady while the dialog fades out.
  const last = useRef<DialogState | null>(null);
  if (state) last.current = state;
  const current = state ?? last.current;
  const close = useCallback(() => onState(null), [onState]);
  useOverlayLayer(open, close);
  useFocusTrap(panel, open && mounted);

  // A new step moves focus to its own first control (the trap handles the first).
  const stepKey = current ? `${current.kind}:${current.kind === 'assign' ? current.step : ''}` : '';
  const seenStep = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !mounted) {
      seenStep.current = null;
      return;
    }
    if (seenStep.current != null && seenStep.current !== stepKey) {
      panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    }
    seenStep.current = stepKey;
  }, [open, mounted, stepKey]);

  if (!mounted || !current) return null;

  let body: ReactNode;
  if (current.kind === 'assign' && current.step === 'pick') {
    body = (
      <PickStep
        titleId={titleId}
        item={current.item}
        fresh={current.fresh}
        onPick={(id) => {
          close();
          void onFile(current.item, id);
        }}
        onCreate={() => onState({ ...current, step: 'create' })}
        onCancel={close}
      />
    );
  } else if (current.kind === 'edit') {
    body = (
      <CategoryForm
        key={current.category.id}
        titleId={titleId}
        title="Edit category"
        submitLabel="Save"
        initial={current.category}
        focus={current.focus}
        onCancel={close}
        onDone={close}
      />
    );
  } else {
    const filing = current.kind === 'assign' ? current : null;
    body = (
      <CategoryForm
        titleId={titleId}
        title="New category"
        submitLabel="Create"
        item={filing?.item}
        onCancel={close}
        onBack={filing && categories.length > 0 ? () => onState({ ...filing, step: 'pick' }) : undefined}
        onDone={(category) => (filing ? onState({ ...filing, step: 'pick', fresh: category.id }) : close())}
      />
    );
  }

  return createPortal(
    <div className={shown ? 'overlay is-shown' : 'overlay'}>
      <div className="overlay-scrim" onClick={close} />
      <div ref={panel} className="dialog category-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div key={stepKey} className="category-step">
          {body}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- picker

function PickStep({
  titleId,
  item,
  fresh,
  onPick,
  onCreate,
  onCancel,
}: {
  titleId: string;
  item: DraggedItem;
  fresh?: string;
  onPick: (categoryId: string | null) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const services = useServices();
  const contents = useCategoryContents();
  const current = services.categories.categoryOf(item);
  const rows = contents.categories;
  const list = useRef<HTMLDivElement>(null);
  const initial = Math.max(
    0,
    rows.findIndex((c) => c.id === (fresh ?? current?.id)),
  );
  const [active, setActive] = useState(initial);

  const focusRow = (i: number) => {
    const buttons = list.current?.querySelectorAll<HTMLElement>('[role="option"]');
    if (!buttons || buttons.length === 0) return;
    const n = (i + buttons.length) % buttons.length;
    setActive(n);
    buttons[n].focus();
    buttons[n].scrollIntoView({ block: 'nearest' });
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const count = rows.length + 1;
    if (e.key === 'ArrowDown') focusRow(active + 1);
    else if (e.key === 'ArrowUp') focusRow(active - 1);
    else if (e.key === 'Home') focusRow(0);
    else if (e.key === 'End') focusRow(count - 1);
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Type-ahead: the next category starting with that letter.
      const letter = e.key.toLowerCase();
      for (let step = 1; step <= rows.length; step++) {
        const i = (active + step) % count;
        if (rows[i]?.name.toLowerCase().startsWith(letter)) {
          focusRow(i);
          break;
        }
      }
    } else return;
    e.preventDefault();
  };

  return (
    <>
      <div className="category-head">
        <h2 id={titleId} className="t-title-lg">
          {current ? 'Move to category' : 'Add to category'}
        </h2>
        <p className="t-body-sm clamp-1 category-subject">{item.title}</p>
      </div>
      <div ref={list} className="category-options" role="listbox" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        {rows.map((c, i) => {
          const isCurrent = c.id === current?.id;
          const count = contents.items.get(c.id)?.length ?? 0;
          return (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={isCurrent}
              tabIndex={i === active ? 0 : -1}
              data-autofocus={i === initial ? '' : undefined}
              className={['category-option', isCurrent && 'is-current', c.id === fresh && 'is-fresh'].filter(Boolean).join(' ')}
              style={hueStyle(c.color)}
              onFocus={() => setActive(i)}
              onClick={() => onPick(c.id)}
            >
              <span className="category-dot" />
              <span className="category-option-name">{c.name}</span>
              {c.id === fresh && <span className="category-new">New</span>}
              <span className="category-option-count tabular">{count}</span>
              <span className="category-option-check">{isCurrent && <CheckIcon size={16} />}</span>
            </button>
          );
        })}
        <button
          type="button"
          role="option"
          aria-selected={false}
          tabIndex={active === rows.length ? 0 : -1}
          className="category-option is-create"
          onFocus={() => setActive(rows.length)}
          onClick={onCreate}
        >
          <AddIcon size={16} />
          <span className="category-option-name">New category…</span>
        </button>
      </div>
      <div className="dialog-actions">
        {current && (
          <button type="button" className="text-button is-muted category-remove" onClick={() => onPick(null)}>
            Remove from {current.name}
          </button>
        )}
        <button type="button" className="text-button is-muted" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- create / edit

/** The item being filed, ready to stand on the preview shelf. */
function useShelfItem(item: DraggedItem | undefined): ShelfItem | null {
  const services = useServices();
  const lib = useStore(services.library);
  const articles = useStore(services.articles);
  return useMemo(() => {
    if (!item) return null;
    if (item.type === 'book') {
      const entry = lib.entries.find((e) => e.book.id === item.id);
      return entry ? { key: `book:${item.id}`, type: 'book', entry } : null;
    }
    const article = articles.items.find((a) => a.id === item.id);
    return article ? { key: `article:${item.id}`, type: 'article', article } : null;
  }, [item, lib.entries, articles.items]);
}

function CategoryForm({
  titleId,
  title,
  submitLabel,
  initial,
  focus = 'name',
  item,
  onCancel,
  onBack,
  onDone,
}: {
  titleId: string;
  title: string;
  submitLabel: string;
  initial?: Category;
  focus?: 'name' | 'color';
  /** The item being filed: it stands on the preview shelf. */
  item?: DraggedItem;
  onCancel: () => void;
  onBack?: () => void;
  onDone: (category: Category) => void;
}) {
  const services = useServices();
  const contents = useCategoryContents();
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState<CategoryColor>(() => initial?.color ?? nextCategoryColor(contents.categories.map((c) => c.color)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedOnce = useRef(false);
  const filing = useShelfItem(item);
  const preview: ShelfItem[] = filing ? [filing] : initial ? (contents.items.get(initial.id) ?? []) : [];

  const trimmed = name.trim();
  const tooLong = trimmed.length > MAX_CATEGORY_NAME;
  const duplicate =
    trimmed.length > 0 && contents.categories.some((c) => c.id !== initial?.id && c.name.trim().toLowerCase() === trimmed.toLowerCase());
  const shownError = error ?? (tooLong ? `Category names can be at most ${MAX_CATEGORY_NAME} characters.` : null);

  const submit = async () => {
    if (busy) return;
    let clean: string;
    try {
      clean = cleanCategoryName(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enter a name for the category.');
      return;
    }
    setBusy(true);
    try {
      if (initial) {
        if (clean !== initial.name || color !== initial.color) await services.categories.update(initial.id, { name: clean, color });
        onDone({ ...initial, name: clean, color });
      } else {
        const category = await services.categories.create(clean, color);
        if (!item) toast.show(`Created ${category.name}`);
        onDone(category);
      }
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error && e.message ? e.message : "Couldn't save the category.");
    }
  };

  return (
    <form
      className="category-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <ShelfScene items={preview} color={color} className="is-preview" />
      <div className="category-head">
        <h2 id={titleId} className="t-title-lg">
          {title}
        </h2>
      </div>
      <div className={shownError ? 'text-field has-prefix is-invalid category-name' : 'text-field has-prefix category-name'} style={hueStyle(color)}>
        <span className="category-dot text-field-prefix" aria-hidden="true" />
        <input
          data-autofocus={focus === 'name' ? '' : undefined}
          type="text"
          enterKeyHint="done"
          autoComplete="off"
          spellCheck={false}
          placeholder="Name, like Programming"
          aria-label="Category name"
          aria-invalid={shownError != null}
          aria-describedby="category-form-status"
          value={name}
          onFocus={(e) => {
            if (initial && !selectedOnce.current) e.target.select();
            selectedOnce.current = true;
          }}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
        />
      </div>
      <ColorPicker value={color} onChange={setColor} autoFocus={focus === 'color'} />
      <div id="category-form-status" className="category-status t-body-sm" aria-live="polite">
        {shownError ? (
          <span className="is-error" role="alert">
            {shownError}
          </span>
        ) : duplicate ? (
          <span className="is-warn">You already have a category with this name.</span>
        ) : trimmed.length >= MAX_CATEGORY_NAME - 10 ? (
          <span className="tabular">
            {trimmed.length} / {MAX_CATEGORY_NAME}
          </span>
        ) : null}
      </div>
      <div className="dialog-actions">
        <button type="button" className="text-button is-muted" onClick={onBack ?? onCancel}>
          {onBack ? 'Back' : 'Cancel'}
        </button>
        <button type="submit" className="text-button" disabled={busy || tooLong}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

const colorNames: Record<CategoryColor, string> = {
  red: 'Red',
  orange: 'Orange',
  amber: 'Amber',
  lime: 'Lime',
  green: 'Green',
  teal: 'Teal',
  cyan: 'Cyan',
  blue: 'Blue',
  indigo: 'Indigo',
  purple: 'Purple',
  pink: 'Pink',
  gray: 'Gray',
};

/** The twelve category colours in picker order; arrows move the choice (a radio group). */
function ColorPicker({ value, onChange, autoFocus }: { value: CategoryColor; onChange: (c: CategoryColor) => void; autoFocus?: boolean }) {
  const group = useRef<HTMLDivElement>(null);
  const move = (delta: number) => {
    const i = categoryColors.indexOf(value);
    const next = categoryColors[(i + delta + categoryColors.length) % categoryColors.length];
    onChange(next);
    group.current?.querySelector<HTMLElement>(`[data-color="${next}"]`)?.focus();
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'ArrowDown') move(6);
    else if (e.key === 'ArrowUp') move(-6);
    else return;
    e.preventDefault();
  };
  return (
    <div ref={group} className="category-swatches" role="radiogroup" aria-label="Colour" onKeyDown={onKeyDown}>
      {categoryColors.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          aria-label={colorNames[c]}
          title={colorNames[c]}
          tabIndex={c === value ? 0 : -1}
          data-color={c}
          data-autofocus={autoFocus && c === value ? '' : undefined}
          className={c === value ? 'category-swatch is-selected' : 'category-swatch'}
          style={{ '--swatch': categoryHues[c] } as CSSProperties}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}
