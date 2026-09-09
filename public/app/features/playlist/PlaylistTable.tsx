import { DragDropContext, Droppable, type DropResult } from '@hello-pangea/dnd';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';

import { t } from '@grafana/i18n';
import { ConfirmModal, FieldSet } from '@grafana/ui';

import { PlaylistVariablesCommitContext } from './PlaylistItemVariables';
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

/** What the open editors committed during one settle, by the row position each belongs to. */
type SettledVariables = Map<number, Record<string, string[]> | undefined>;

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

  // The scope the playlist form provides, holding the editors it has open. Undefined only where
  // this table is rendered outside that form, which is a test fixture rather than the product.
  const commitScope = useContext(PlaylistVariablesCommitContext);
  /** Where a settle in progress records what it committed, and nothing at any other time. */
  const settleInProgress = useRef<SettledVariables | undefined>(undefined);

  /**
   * Commits what the open editors are holding, and reports what they committed by row position.
   *
   * Every change this component makes either takes an editor away — collapsing a row, deleting a
   * row, lifting one for a drag — or moves the item a row stands for, and a variable typed into an
   * editor but not yet added is only in that editor. So it is committed first, while the rows are
   * still the rows it was typed into: settling afterwards would apply it to whichever item had
   * taken that position.
   */
  const settleOpenEditors = useCallback((): SettledVariables => {
    const settled: SettledVariables = new Map();
    settleInProgress.current = settled;
    try {
      commitScope?.settle();
    } finally {
      settleInProgress.current = undefined;
    }
    return settled;
  }, [commitScope]);

  const toggleExpanded = useCallback(
    (index: number) => {
      settleOpenEditors();
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
    },
    [settleOpenEditors]
  );

  const collapseAll = useCallback(() => {
    settleOpenEditors();
    setExpanded((previous) => (previous.size === 0 ? previous : new Set()));
  }, [settleOpenEditors]);

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

  /**
   * How many unsaved variables the row at `index` would lose if it were removed.
   *
   * `settled` is what the settle that has just run committed, and it takes precedence over the
   * item: those maps reach the item list on the next render, which is after this deletion has been
   * decided, so a variable the user typed and never added would otherwise be counted as absent and
   * discarded without a word.
   */
  const unsavedVariableCount = (index: number, settled: SettledVariables) => {
    const key = itemKeys[index];
    if (!key || !editedKeys.current.has(key)) {
      return 0;
    }

    const item = items[index];
    const variables = settled.has(index) ? settled.get(index) : item?.variables;
    return item ? Object.keys(variables ?? {}).length : 0;
  };

  const onDelete = (index: number) => {
    // Planned here rather than on confirmation, because the confirmation dialog takes focus away
    // from the row before the user answers it. Planned before the settle too, since the plan is
    // read off where focus is now.
    const plan = planFocusAfterDelete(index);
    const settled = settleOpenEditors();
    const variableCount = unsavedVariableCount(index, settled);
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
    // A settle reaches this the same way an ordinary edit does, so it is recorded for whatever
    // asked for the settle to read back before the change it is about to make.
    settleInProgress.current?.set(index, variables);
    onVariablesChange(index, variables);
  };

  const onDragEnd = (d: DropResult) => {
    // The lift collapsed the editors already; going through the same call is what settles anything
    // an editor is still holding for a drag that reached this without one, and the settle sees the
    // positions the rows had before the move.
    collapseAll();
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
