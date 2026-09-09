import { DragDropContext, Droppable, type DropResult } from '@hello-pangea/dnd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { t } from '@grafana/i18n';
import { ConfirmModal, FieldSet } from '@grafana/ui';

import { PlaylistTableRows } from './PlaylistTableRows';
import { type PlaylistItemUI } from './types';
import { usePlaylistItemKeys } from './usePlaylistItems';

interface Props {
  items: PlaylistItemUI[];
  deleteItem: (idx: number) => void;
  moveItem: (src: number, dst: number) => void;
  onVariablesChange: (index: number, variables?: Record<string, string[]>) => void;
}

/**
 * Where focus goes once a removal has taken away the control that held it: the position of the
 * surviving row to move to, or -1 for the list itself when no row survives. A plan is made before
 * the removal, while the row that holds focus can still be identified, and applied afterwards.
 *
 * It is an object rather than the number itself so that two deletions planning the same position
 * are still two distinct plans, which is what re-runs the effect that applies them.
 */
interface FocusPlan {
  index: number;
}

interface PendingDelete {
  index: number;
  variableCount: number;
  plan: FocusPlan;
}

/** Markers `PlaylistTableRows` puts on the row wrapper and on the drag handle inside it. */
const ROW_INDEX_ATTRIBUTE = 'data-playlist-item-index';
const DRAG_HANDLE_SELECTOR = '[data-playlist-item-drag-handle]';

export const PlaylistTable = ({ items, deleteItem, moveItem, onVariablesChange }: Props) => {
  // Rows are identified by position and the same dashboard UID can appear several times with
  // different variables, so an editor left open across a move or a deletion would re-attach to a
  // different item. Every structural change therefore collapses all open editors.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [focusPlan, setFocusPlan] = useState<FocusPlan | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Rows whose variables have been edited in this session, held by item key rather than by
  // position so the record follows its own row across a reorder or another row's deletion. These
  // values exist nowhere else until the playlist is saved, which is why removing such a row asks
  // for confirmation while removing a row whose variables are still stored does not.
  const editedKeys = useRef(new Set<string>());
  const itemKeys = usePlaylistItemKeys(items);

  const toggleExpanded = useCallback((index: number) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setExpanded((previous) => (previous.size === 0 ? previous : new Set()));
  }, []);

  const focusRow = useCallback((index: number) => {
    const list = listRef.current;
    if (!list) {
      return;
    }

    const row = list.querySelector(`[${ROW_INDEX_ATTRIBUTE}="${index}"]`);
    // The disclosure is preferred over the delete button of the same row: a second Enter on a
    // relocated delete button would remove another item. A row without a disclosure — a tag row —
    // offers its drag handle instead, and the list itself is the target when no row is left.
    const target = row?.querySelector('[aria-expanded]') ?? row?.querySelector(DRAG_HANDLE_SELECTOR) ?? list;
    if (target instanceof HTMLElement) {
      target.focus();
    }
  }, []);

  /** The row whose open variables panel currently holds focus, if any. */
  const rowHoldingFocus = () => {
    const list = listRef.current;
    const active = document.activeElement;
    if (!list || !active || !list.contains(active)) {
      return null;
    }

    const value = active
      .closest('[role="region"]')
      ?.closest(`[${ROW_INDEX_ATTRIBUTE}]`)
      ?.getAttribute(ROW_INDEX_ATTRIBUTE);
    if (!value) {
      return null;
    }

    const index = Number.parseInt(value, 10);
    return Number.isNaN(index) ? null : index;
  };

  const planFocusAfterDelete = (index: number): FocusPlan => {
    const remaining = items.length - 1;
    if (remaining < 1) {
      return { index: -1 };
    }

    // Deleting any row collapses every editor, so a panel open on another row is unmounted even
    // though that row survives: focus returns to the disclosure of the row being edited, at the
    // position it holds once the deleted row is gone.
    const editing = rowHoldingFocus();
    if (editing !== null && editing !== index) {
      return { index: editing > index ? editing - 1 : editing };
    }

    // Otherwise the removed row itself held focus, so the row that takes its place receives it —
    // the last surviving row when the list end was deleted.
    return { index: Math.min(index, remaining - 1) };
  };

  const removeItem = (index: number, plan: FocusPlan) => {
    setExpanded(new Set());
    deleteItem(index);
    setFocusPlan(plan);
  };

  const unsavedVariableCount = (index: number) => {
    const key = itemKeys[index];
    if (!key || !editedKeys.current.has(key)) {
      return 0;
    }

    const item = items[index];
    return item ? Object.keys(item.variables ?? {}).length : 0;
  };

  const onDelete = (index: number) => {
    // Planned here rather than on confirmation, because the confirmation dialog takes focus away
    // from the row before the user answers it.
    const plan = planFocusAfterDelete(index);
    const variableCount = unsavedVariableCount(index);
    if (variableCount > 0) {
      setPendingDelete({ index, variableCount, plan });
      return;
    }

    removeItem(index, plan);
  };

  const onConfirmDelete = () => {
    const pending = pendingDelete;
    setPendingDelete(null);
    if (pending) {
      removeItem(pending.index, pending.plan);
    }
  };

  const onVariablesEdited = (index: number, variables?: Record<string, string[]>) => {
    const key = itemKeys[index];
    if (key) {
      editedKeys.current.add(key);
    }
    onVariablesChange(index, variables);
  };

  const onDragEnd = (d: DropResult) => {
    setExpanded(new Set());
    if (d.destination) {
      moveItem(d.source.index, d.destination?.index);
    }
  };

  useEffect(() => {
    if (!focusPlan) {
      return;
    }

    setFocusPlan(null);
    const { index } = focusPlan;
    // A dismissed dialog returns focus to the control that opened it from a microtask of its own,
    // and that control has just been removed with its row, so the move has to be queued behind it.
    queueMicrotask(() => focusRow(index));
  }, [focusPlan, focusRow]);

  return (
    <FieldSet label={t('playlist-edit.form.table-heading', 'Dashboards')}>
      {/*
        The panel of an expanded row is a sibling of the row inside the draggable wrapper, so it
        would otherwise be measured and lifted with it, making a dragged row several times taller
        than the rows it is dropped between. Collapsing before the library captures the dimensions
        keeps the dragged row the size of a row. The library flushes this responder synchronously.
      */}
      <DragDropContext onBeforeCapture={collapseAll} onDragEnd={onDragEnd}>
        <Droppable droppableId="playlist-list" direction="vertical">
          {(provided) => {
            const hasItems = items.length > 0;
            return (
              <div
                ref={(node) => {
                  provided.innerRef(node);
                  listRef.current = node;
                }}
                {...provided.droppableProps}
                // Focus lands here when the row that held it was the last one to be removed. A
                // negative tabindex keeps the list out of the tab sequence while still allowing
                // focus to be moved to it deliberately.
                tabIndex={-1}
                // The items are a list: each row carries one item's name and its controls, and an
                // expanded row carries its variables editor as well, which is not tabular content.
                // A `list` may own only `listitem` elements, so the role is carried while there are
                // rows and dropped for the empty-state text the rows render in their place — with
                // it, that paragraph would be a child the list is not allowed to own.
                role={hasItems ? 'list' : undefined}
                aria-label={hasItems ? t('playlist-edit.form.table-list-label', 'Playlist items') : undefined}
              >
                <PlaylistTableRows
                  items={items}
                  itemKeys={itemKeys}
                  onDelete={onDelete}
                  expanded={expanded}
                  onToggleExpanded={toggleExpanded}
                  onVariablesChange={onVariablesEdited}
                />
                {provided.placeholder}
              </div>
            );
          }}
        </Droppable>
      </DragDropContext>
      <ConfirmModal
        isOpen={pendingDelete !== null}
        title={t('playlist-edit.form.delete-item-title', 'Delete playlist item')}
        body={t('playlist-edit.form.delete-item-body', '', {
          count: pendingDelete?.variableCount ?? 0,
          defaultValue_one:
            'This item has {{count}} template variable that has not been saved yet. Deleting the item discards it.',
          defaultValue_other:
            'This item has {{count}} template variables that have not been saved yet. Deleting the item discards them.',
        })}
        confirmText={t('playlist-edit.form.delete-item-confirm', 'Delete item')}
        onConfirm={onConfirmDelete}
        onDismiss={() => setPendingDelete(null)}
      />
    </FieldSet>
  );
};
