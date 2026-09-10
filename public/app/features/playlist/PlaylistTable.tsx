import { css } from '@emotion/css';
import { DragDropContext, Droppable, type DropResult } from '@hello-pangea/dnd';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';

import { selectors } from '@grafana/e2e-selectors';
import { t } from '@grafana/i18n';
import { ConfirmModal, FieldSet, useStyles2 } from '@grafana/ui';

import { MIN_HIT_TARGET_SIZE, PlaylistVariablesCommitContext } from './PlaylistItemVariables';
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
 * Which control of the planned row receives focus.
 *
 * `preferDisclosure` is what a removal asks for: the row that took the removed row's place is
 * reached at its disclosure rather than at its delete button, so a second Enter cannot remove
 * another item. `dragHandle` is what a completed drag asks for, because the handle is the control
 * the drag was performed with and the one a further reorder continues from. `delete` is what a
 * dismissed deletion asks for, where nothing was removed and the control that opened the dialog is
 * still on the row it belongs to.
 */
type FocusTarget = 'preferDisclosure' | 'dragHandle' | 'delete';

/**
 * Where focus goes once a change has taken away, moved or covered the control that held it: the
 * position of the row to move to — or -1 for the list itself when a removal leaves no row — and
 * which of that row's controls to move to. A plan is made before the change, while the row that
 * holds focus can still be identified, and applied afterwards.
 *
 * It is an object rather than the values themselves so that two changes planning the same position
 * are still two distinct plans, which is what re-runs the effect that applies them.
 */
interface FocusPlan {
  index: number;
  target: FocusTarget;
}

interface PendingDelete {
  index: number;
  variableCount: number;
  plan: FocusPlan;
}

/** Markers `PlaylistTableRows` puts on the row wrapper and on the controls inside it. */
const ROW_INDEX_ATTRIBUTE = 'data-playlist-item-index';
const DRAG_HANDLE_SELECTOR = '[data-playlist-item-drag-handle]';
const DELETE_SELECTOR = '[data-playlist-item-delete]';

/** What the open editors committed during one settle, by the row position each belongs to. */
type SettledVariables = Map<number, Record<string, string[]> | undefined>;

export const PlaylistTable = ({ items, deleteItem, moveItem, onVariablesChange }: Props) => {
  const styles = useStyles2(getStyles);
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
      // Not a submit: what this settles for is a row about to be collapsed, deleted or lifted, and
      // that change goes ahead whatever the editors answer. The intent is what keeps a message on
      // another row's field from pulling focus out of the change being made.
      commitScope?.settle('structural-change');
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

  const focusRow = useCallback((index: number, target: FocusTarget) => {
    const list = listRef.current;
    if (!list) {
      return;
    }

    const row = list.querySelector(`[${ROW_INDEX_ATTRIBUTE}="${index}"]`);
    // The disclosure is preferred over the delete button of the same row: a second Enter on a
    // relocated delete button would remove another item. A drag and a dismissed deletion name the
    // control they came from instead, which is still the control the user is working with.
    const wanted =
      target === 'dragHandle'
        ? row?.querySelector(DRAG_HANDLE_SELECTOR)
        : target === 'delete'
          ? row?.querySelector(DELETE_SELECTOR)
          : row?.querySelector('[aria-expanded]');
    // A row without a disclosure — a tag row — offers its drag handle instead, and the list itself
    // is the target when no row is left.
    const element = wanted ?? row?.querySelector(DRAG_HANDLE_SELECTOR) ?? list;
    if (element instanceof HTMLElement) {
      element.focus();
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
      return { index: -1, target: 'preferDisclosure' };
    }

    // Deleting any row collapses every editor, so a panel open on another row is unmounted even
    // though that row survives: focus returns to the disclosure of the row being edited, at the
    // position it holds once the deleted row is gone.
    const editing = rowHoldingFocus();
    if (editing !== null && editing !== index) {
      return { index: editing > index ? editing - 1 : editing, target: 'preferDisclosure' };
    }

    // Otherwise the removed row itself held focus, so the row that takes its place receives it —
    // the last surviving row when the list end was deleted.
    return { index: Math.min(index, remaining - 1), target: 'preferDisclosure' };
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

  /**
   * Dismisses the question without removing anything.
   *
   * The row, its variables and every control on it are exactly as they were, so the plan the
   * removal would have followed does not apply: focus belongs on the delete control that opened the
   * dialog. Without this the dialog unmounts and takes focus with it — a keyboard user who declined
   * the deletion was left on the document body, at the top of the page, with the row they were
   * working on somewhere below.
   */
  const onDismissDelete = () => {
    const pending = pendingDelete;
    setPendingDelete(null);
    if (pending) {
      setFocusPlan({ index: pending.index, target: 'delete' });
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
      moveItem(d.source.index, d.destination.index);
      // A drag performed with the keyboard is left focused on its handle by the library, which
      // holds the element it lifted. A drag performed with a pointer never gave the handle focus,
      // so the drop left it on the document body: the row had been moved and nothing on the page
      // was focused, which is where a keyboard user arriving mid-flow would have to start over.
      // The handle of the row at its new position is the control the reorder continues from.
      setFocusPlan({ index: d.destination.index, target: 'dragHandle' });
    }
  };

  useEffect(() => {
    if (!focusPlan) {
      return;
    }

    setFocusPlan(null);
    const { index, target } = focusPlan;
    // A dismissed dialog returns focus to the control that opened it from a microtask of its own,
    // and that control has either just been removed with its row or is the one being moved to, so
    // the move has to be queued behind it.
    queueMicrotask(() => focusRow(index, target));
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
        modalClass={styles.confirmDialog}
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
        onDismiss={onDismissDelete}
      />
    </FieldSet>
  );
};

function getStyles() {
  return {
    /**
     * The confirmation's own controls, at 44 px.
     *
     * `ConfirmModal` builds its button row itself, from `size="md"` buttons that are 32 px tall,
     * and inherits `Modal`'s 24 px close control — none of which a caller can size through a prop.
     * `modalClass` lands on the dialog root, so raising them from here reaches this confirmation
     * and no other dialog in the product. The close control is matched by the stable e2e selector
     * it carries rather than by its translated accessible name.
     */
    confirmDialog: css({
      button: {
        minWidth: MIN_HIT_TARGET_SIZE,
        minHeight: MIN_HIT_TARGET_SIZE,
      },
      [`[data-testid="${selectors.components.Modal.closeButton}"]`]: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
    }),
  };
}
