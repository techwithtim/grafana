import { css, cx } from '@emotion/css';
import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';

import { type GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { Alert, Button, Field, IconButton, Input, Text, useStyles2 } from '@grafana/ui';

import {
  MAX_VALUES_PER_VARIABLE,
  MAX_VARIABLE_NAME_LENGTH,
  MAX_VARIABLE_NAME_TEXT_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  MAX_VARIABLE_VALUES_TEXT_LENGTH,
  MAX_VARIABLES_PER_ITEM,
  isWithinCodePointLimit,
  isWithinVariableBudget,
} from './variableLimits';

interface Props {
  variables?: Record<string, string[]>;
  /**
   * Position, counted from one, of the playlist item this editor belongs to.
   *
   * A playlist may list one dashboard several times with a different variable set on each entry,
   * and those entries name their variables alike: two open editors would expose two controls named
   * `Variable name for host` with nothing to tell them apart. The position discriminates them.
   * Omitted when this editor is not rendered for a row of a list, where there is nothing to
   * discriminate and the plainer names read better.
   */
  itemPosition?: number;
  /**
   * Receives a complete replacement map, or `undefined` once the last variable is removed. The
   * editor never mutates `variables`: that map belongs to the caller, and may be a value held in
   * an RTK Query cache entry.
   */
  onChange: (next?: Record<string, string[]>) => void;
}

type RowField = 'name' | 'values';

/** The controls of an existing row focus can be moved to: its two inputs and its remove button. */
type RowControl = RowField | 'remove';

/**
 * Where focus is to be placed once the render that strands it has reached the DOM.
 *
 * `names` are candidate committed rows in priority order and the request resolves to the first one
 * that still has `control` rendered, because a row named here may have been removed, renamed again
 * by the caller, or never have unmounted at all. `fallbackToNewRow` is what a removal asks for when
 * no committed row survives it.
 */
interface FocusRequest {
  names: string[];
  control: RowControl;
  fallbackToNewRow: boolean;
}

interface RowDraft {
  name: string;
  values: string;
}

interface RowError {
  field: RowField;
  message: string;
}

/**
 * The uncommitted text and validation messages of the existing rows, keyed by the committed
 * variable name each row was opened on.
 *
 * A variable name is arbitrary user text, so `toString`, `constructor` and `__proto__` are as
 * valid as `host`. Maps rather than objects keep those names as data: an object would answer a
 * lookup for them with a member of `Object.prototype`, which is neither a draft nor `undefined`.
 */
interface RowState {
  drafts: Map<string, RowDraft>;
  errors: Map<string, RowError>;
}

const EMPTY_DRAFT: RowDraft = { name: '', values: '' };
const EMPTY_ROW_STATE: RowState = { drafts: new Map(), errors: new Map() };

/** What one editor found when the enclosing form asked it to settle its uncommitted text. */
type SettleOutcome = 'settled' | 'blocked';

/**
 * The link between the editors open under a form and that form's submit.
 *
 * An editor holds text that is not yet part of the playlist item — a half-typed add row, or a row
 * being edited — and the form has no other way to learn of it. Submitting regardless is what makes
 * a save either drop what the user typed or store the value they had just replaced, both while
 * reporting success.
 */
export interface PlaylistVariablesCommitScope {
  /** Registers an open editor and returns the function that removes it again. */
  register: (settle: () => SettleOutcome) => () => void;
}

export const PlaylistVariablesCommitContext = createContext<PlaylistVariablesCommitScope | undefined>(undefined);

/**
 * Gives a form the scope to provide to the editors below it, and the check to run before it saves.
 *
 * `settlePendingVariables` returns whether the form may go on: every open editor commits what it
 * can and shows a message for what it cannot, and a single refusal makes the answer `false`. Each
 * editor is asked even after one has refused, so one row's rejected text cannot leave another
 * row's valid text uncommitted.
 */
export function usePlaylistVariablesCommit(): {
  commitScope: PlaylistVariablesCommitScope;
  settlePendingVariables: () => boolean;
} {
  const editorsRef = useRef<Set<() => SettleOutcome>>(new Set());

  const commitScope = useMemo<PlaylistVariablesCommitScope>(
    () => ({
      register: (settle) => {
        const editors = editorsRef.current;
        editors.add(settle);
        return () => {
          editors.delete(settle);
        };
      },
    }),
    []
  );

  const settlePendingVariables = useCallback(() => {
    let settled = true;
    // A copy, because an editor that commits re-renders its parent, and a set being iterated is
    // not the place to discover a registration or a removal.
    for (const settle of Array.from(editorsRef.current)) {
      if (settle() === 'blocked') {
        settled = false;
      }
    }
    return settled;
  }, []);

  return { commitScope, settlePendingVariables };
}

/**
 * The only place playlist variable values are parsed: the runtime serializes the stored lists
 * with `urlUtil.toUrlParams` and never re-splits them. Commas are delimiters with no escape, so
 * a value containing one cannot be expressed here.
 */
function parseValues(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function draftFor(name: string, values: string[]): RowDraft {
  return { name, values: values.join(', ') };
}

/**
 * The item's variables in the order they are shown, which is by name.
 *
 * The stored order is not one the user can rely on: a map keeps the order its names were added in
 * until it is saved, and comes back from the API in key order, so the list built in this editor is
 * not the list it reopens. Ordering the rows here instead makes the sequence the same before a
 * save, after it, and on every later visit, whatever order the object arrived in.
 *
 * The comparison is on code units rather than a locale collation: it has to answer identically for
 * the same two names in every session and every language, which a collator does not promise.
 */
function displayOrder(entries: Array<[string, string[]]>): Array<[string, string[]]> {
  return Array.from(entries).sort(([left], [right]) => {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  });
}

/** The rows with `name` replaced by `nextName` and `nextValues`, keeping the position it held. */
function withRow(
  rows: Map<string, string[]>,
  name: string,
  nextName: string,
  nextValues: string[]
): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const [rowName, rowValues] of rows) {
    if (rowName === name) {
      next.set(nextName, nextValues);
    } else {
      next.set(rowName, rowValues);
    }
  }
  return next;
}

function withoutRow<T>(rows: Map<string, T>, name: string): Map<string, T> {
  const next = new Map(rows);
  next.delete(name);
  return next;
}

/**
 * Drops the pending state of rows the item no longer holds, and keeps every other row's.
 *
 * A rename, a removal, or an update arriving from the parent leaves keys behind that no longer
 * identify a row, and re-attaching one to another variable would show one row's text under
 * another name. Rows that are still committed are left exactly as they are, so text being typed
 * into one row survives a change to an unrelated one. The state object is returned unchanged when
 * nothing is stale, which is what stops the reconciliation below from looping.
 */
function reconcileRows(state: RowState, committed: Map<string, string[]>): RowState {
  const isStale = (name: string) => !committed.has(name);
  const staleDrafts = Array.from(state.drafts.keys()).filter(isStale);
  const staleErrors = Array.from(state.errors.keys()).filter(isStale);
  if (staleDrafts.length === 0 && staleErrors.length === 0) {
    return state;
  }

  const drafts = new Map(state.drafts);
  const errors = new Map(state.errors);
  staleDrafts.forEach((name) => drafts.delete(name));
  staleErrors.forEach((name) => errors.delete(name));
  return { drafts, errors };
}

export const PlaylistItemVariables = ({ variables, itemPosition, onChange }: Props) => {
  const styles = useStyles2(getStyles);
  const newNameId = useId();
  const newValuesId = useId();
  const newAddId = useId();

  // A stored map that breaks the budget is never enumerated: one row is several controls, and
  // building them for every name is the exhaustion the budget exists to prevent. The message below
  // takes the place of the rows.
  const withinBudget = isWithinVariableBudget(variables);
  const entries = withinBudget ? Object.entries(variables ?? {}) : [];
  const committed = new Map(entries);
  const committedNames = Array.from(committed.keys());

  const [rowState, setRowState] = useState<RowState>(EMPTY_ROW_STATE);
  const [newDraft, setNewDraft] = useState<RowDraft>(EMPTY_DRAFT);
  const [newError, setNewError] = useState<RowError | undefined>(undefined);

  /**
   * Set when leaving the add row committed it, and consumed by an explicit commit that then finds
   * the row empty.
   *
   * Pressing the add button both leaves the row and asks for it to be added. Where the browser
   * reports the button as the new focus target the leaving is not a commit at all and this never
   * applies; where it reports no target — some browsers do not focus a button on a mouse press —
   * the row is committed on the way out and the click that follows would otherwise be read as an
   * attempt to add an empty variable and answer it with a message about a row that was just added.
   */
  const committedOnLeaveRef = useRef(false);

  // Reconciling against the committed names as they arrive, rather than in an effect, means the
  // rows below already read the reconciled state; the write only carries it into the next render.
  const { drafts, errors } = reconcileRows(rowState, committed);
  if (rowState.drafts !== drafts) {
    setRowState({ drafts, errors });
  }

  /**
   * The rendered controls of the existing rows, keyed by the committed name and then by control.
   *
   * A row is keyed by its variable name, so removing one unmounts it and renaming one replaces it:
   * either way the element holding focus can be gone by the time focus has to be placed again, and
   * only the elements registered here at that moment are real. A rename detaches the old row's
   * entries and attaches the replacement's under a different name, so the two cannot overwrite each
   * other whichever order React runs them in.
   */
  const rowControls = useRef(new Map<string, Map<RowControl, HTMLElement>>());
  const newNameInput = useRef<HTMLInputElement | null>(null);
  const pendingFocus = useRef<FocusRequest | undefined>(undefined);
  // Read by nothing: the state exists only so that raising a request always causes a render for the
  // effect below to run in. Elided rather than named, because a name here would be an unused one.
  const [, bumpFocusSerial] = useState(0);

  /**
   * The element the user's own action is carrying focus to, recorded by the handler that starts a
   * commit. A rename destroys the row mid-action, and this is where focus was going.
   */
  const commitFocusTarget = useRef<HTMLElement | undefined>(undefined);

  const registerRowControl = (name: string, control: RowControl, element: HTMLElement | null) => {
    const controls = rowControls.current.get(name);
    if (!element) {
      // Only this one entry is dropped. React detaches a row's refs one control at a time, and the
      // row is still rendering the others.
      controls?.delete(control);
      if (controls?.size === 0) {
        rowControls.current.delete(name);
      }
      return;
    }
    if (controls) {
      controls.set(control, element);
      return;
    }
    rowControls.current.set(name, new Map([[control, element]]));
  };

  /** Which of a row's own controls `element` is, or `undefined` when it is none of them. */
  const rowControlOf = (name: string, element: HTMLElement): RowControl | undefined => {
    const controls = rowControls.current.get(name);
    if (!controls) {
      return undefined;
    }
    for (const [control, candidate] of controls) {
      if (candidate === element) {
        return control;
      }
    }
    return undefined;
  };

  const requestFocus = (request: FocusRequest) => {
    pendingFocus.current = request;
    // The request is resolved in an effect, which needs a render to run after. The change that
    // strands focus usually causes one on its own — but not always: a caller that ignores
    // `onChange`, and a removal of a row with nothing typed into it, leave this component with
    // nothing to re-render for, and the request would then sit here until some later, unrelated
    // render resolved it against a DOM it was never meant for.
    bumpFocusSerial((previous) => previous + 1);
  };

  /**
   * Places focus after the render that unmounted the element holding it.
   *
   * This runs after every render and returns immediately unless a request is waiting, because the
   * render that resolves a request is the one that removed or replaced the row, and that is the DOM
   * the candidates have to be looked up in. It is a layout effect so the move happens before the
   * browser paints, rather than showing a frame with focus on the document body.
   */
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    if (!request) {
      return;
    }
    pendingFocus.current = undefined;

    for (const name of request.names) {
      const element = rowControls.current.get(name)?.get(request.control);
      if (element) {
        element.focus();
        return;
      }
    }
    if (request.fallbackToNewRow) {
      newNameInput.current?.focus();
    }
    // A request that resolves to nothing and asks for no fallback deliberately leaves focus where
    // it is: it was raised for an element that turns out not to have been unmounted, and taking
    // focus off whatever holds it now would be a defect rather than a repair.
  });

  /**
   * The reason a row cannot be committed, or `undefined` when it can.
   *
   * The maxima are the same contract the playlist runtime and the API enforce, so a row the editor
   * accepts is a row that is stored and played whole. Every message is fixed text carrying only the
   * limit as a number: the name and the values are the untrusted content, and echoing either into
   * the page is what a validation message must not do. `isNewVariable` adds the one check that
   * belongs to the add row alone, since an existing row does not grow the map.
   */
  const validate = (
    name: string,
    values: string[],
    otherNames: string[],
    isNewVariable = false
  ): RowError | undefined => {
    if (name === '') {
      return {
        field: 'name',
        message: t('playlist-edit.form.variables-name-required', 'Variable name is required'),
      };
    }
    if (values.length === 0) {
      return {
        field: 'values',
        message: t('playlist-edit.form.variables-value-required', 'Variable value is required'),
      };
    }
    if (!isWithinCodePointLimit(name, MAX_VARIABLE_NAME_LENGTH)) {
      return {
        field: 'name',
        message: t(
          'playlist-edit.form.variables-name-too-long',
          'Variable name cannot be longer than {{maxLength}} characters',
          { maxLength: MAX_VARIABLE_NAME_LENGTH }
        ),
      };
    }
    if (values.length > MAX_VALUES_PER_VARIABLE) {
      return {
        field: 'values',
        message: t('playlist-edit.form.variables-too-many-values', 'A variable cannot have more than {{max}} values', {
          max: MAX_VALUES_PER_VARIABLE,
        }),
      };
    }
    if (values.some((value) => !isWithinCodePointLimit(value, MAX_VARIABLE_VALUE_LENGTH))) {
      return {
        field: 'values',
        message: t(
          'playlist-edit.form.variables-value-too-long',
          'A variable value cannot be longer than {{maxLength}} characters',
          { maxLength: MAX_VARIABLE_VALUE_LENGTH }
        ),
      };
    }
    if (isNewVariable && otherNames.length >= MAX_VARIABLES_PER_ITEM) {
      return {
        field: 'name',
        message: t('playlist-edit.form.variables-too-many', 'A playlist item cannot have more than {{max}} variables', {
          max: MAX_VARIABLES_PER_ITEM,
        }),
      };
    }
    if (otherNames.includes(name)) {
      return {
        field: 'name',
        message: t('playlist-edit.form.variables-name-duplicate', 'A variable with this name already exists'),
      };
    }
    return undefined;
  };

  const updateDraft = (name: string, field: RowField, value: string) => {
    setRowState((previous) => {
      const draft = previous.drafts.get(name) ?? draftFor(name, committed.get(name) ?? []);
      const drafts = new Map(previous.drafts).set(
        name,
        field === 'name' ? { ...draft, name: value } : { ...draft, values: value }
      );
      // Typing is how the user fixes a rejected row, so the message must not linger over new
      // input — but only over the input it belongs to. An error on the other field of the row is
      // still unresolved, and hiding it would report the row as fixed when it is not.
      const errors = previous.errors.get(name)?.field === field ? withoutRow(previous.errors, name) : previous.errors;
      return { drafts, errors };
    });
  };

  const clearRow = (name: string) => {
    setRowState((previous) => {
      if (!previous.drafts.has(name) && !previous.errors.has(name)) {
        return previous;
      }
      return { drafts: withoutRow(previous.drafts, name), errors: withoutRow(previous.errors, name) };
    });
  };

  const commitRow = (name: string) => {
    // Read once and cleared here, so a commit that is rejected, that changes nothing, or that has
    // nothing to commit at all cannot leave a target behind for a later commit to act on.
    const focusTarget = commitFocusTarget.current;
    commitFocusTarget.current = undefined;

    const draft = drafts.get(name);
    if (!draft) {
      // Blur also fires when a row is merely focused, so an untouched row has nothing to commit.
      return;
    }

    const nextName = draft.name.trim();
    const nextValues = parseValues(draft.values);
    // A row may keep its own name without colliding with itself, so only the other rows are checked.
    const error = validate(
      nextName,
      nextValues,
      committedNames.filter((other) => other !== name)
    );
    if (error) {
      setRowState((previous) => ({ ...previous, errors: new Map(previous.errors).set(name, error) }));
      return;
    }

    // An edit is committed once. Dropping the draft here leaves a second blur, or Enter pressed
    // again, with nothing to commit, and returns the inputs to the values the item now holds
    // rather than the text they were typed with. Only this row is dropped, so a neighbouring row
    // keeps whatever is half-typed in it.
    clearRow(name);

    // A row is keyed by its variable name, so a rename unmounts this row and mounts the renamed one
    // in its place — with the element the user's own action was carrying focus to inside it, which
    // leaves focus on the document body. Asking for the same control of the renamed row carries
    // focus across that replacement instead. A target outside this row (the add row's fields, Save)
    // survives the replacement and keeps the focus it is being given: pulling it back would fight
    // the user's own movement.
    if (nextName !== name && focusTarget) {
      const control = rowControlOf(name, focusTarget);
      if (control) {
        requestFocus({ names: [nextName, name], control, fallbackToNewRow: false });
      }
    }

    onChange(Object.fromEntries(withRow(committed, name, nextName, nextValues)));
  };

  const updateNewDraft = (field: RowField, value: string) => {
    setNewDraft((previous) => (field === 'name' ? { ...previous, name: value } : { ...previous, values: value }));
    setNewError((previous) => (previous?.field === field ? undefined : previous));
    // Typing is a new attempt, so the row being empty from here on is the user's doing and is
    // answered as such.
    committedOnLeaveRef.current = false;
  };

  /** Whether the add row holds text the user has typed and not yet added. */
  const newRowHasText = newDraft.name.trim() !== '' || newDraft.values.trim() !== '';

  /**
   * Adds the variable in the add row, or reports why it cannot be added.
   *
   * `leavingRow` distinguishes the two ways this happens. Asked for explicitly — the add button or
   * Enter — an empty row is an attempt to add nothing and is answered with the missing-name
   * message, which is the only feedback that request can produce. Reached by leaving the row, an
   * empty row is simply a row that was never used, and saying anything about it would put a
   * message under a field the user never touched.
   */
  const commitNewRow = ({ leavingRow = false }: { leavingRow?: boolean } = {}) => {
    const name = newDraft.name.trim();
    const values = parseValues(newDraft.values);

    if (!newRowHasText && (leavingRow || committedOnLeaveRef.current)) {
      committedOnLeaveRef.current = false;
      return;
    }

    const error = validate(name, values, committedNames, true);
    if (error) {
      setNewError(error);
      return;
    }

    setNewError(undefined);
    setNewDraft(EMPTY_DRAFT);
    committedOnLeaveRef.current = leavingRow;
    // Building the map through Object.fromEntries defines every name as an own property of the
    // result. Assigning one would let a variable named `__proto__` rewrite the map's prototype
    // instead of appearing in it, losing the variable the user just added.
    onChange(Object.fromEntries(new Map(entries).set(name, values)));
  };

  /** Whether an element is one of the add row's own controls, so focus reaching it is not a leave. */
  const isNewRowControl = (element: EventTarget | null) =>
    element instanceof HTMLElement &&
    (element.id === newNameId || element.id === newValuesId || element.id === newAddId);

  /**
   * Commits the add row when focus leaves it, the way leaving a committed row's field commits that
   * row.
   *
   * This is what carries a typed variable through the two moments it would otherwise be dropped
   * without a word: collapsing the panel, which unmounts this component and everything in it, and
   * saving the playlist. Both begin by moving focus out of this row — to the disclosure, to a
   * delete control, to the save button — so the variable is added while the item is still the one
   * the user was editing, before any collapse, reorder or deletion has moved it.
   */
  const handleNewRowBlur = (event: FocusEvent<HTMLInputElement>) => {
    if (isNewRowControl(event.relatedTarget)) {
      return;
    }
    commitNewRow({ leavingRow: true });
  };

  /**
   * Commits every piece of uncommitted text at once and reports whether the form may save.
   *
   * Reached only from the enclosing form's submit, and it exists because a save is the last moment
   * this text can still be honoured. Leaving a field is what normally commits it, so by the time a
   * click on save arrives there is usually nothing here to do — but a submit can also arrive
   * without any field having been left, and then this is the difference between saving what is on
   * screen and saving what it replaced.
   *
   * Everything is applied to one map and emitted once. Committing each row on its own would have
   * every commit rebuild the item from the same starting point, so the last would be the only one
   * to survive and the others would be silently undone.
   */
  const settlePending = (): SettleOutcome => {
    // A stored map beyond the budget is rendered as a message with no controls in it, so there is
    // nothing here the user could have typed.
    if (!withinBudget) {
      return 'settled';
    }

    let next = new Map(committed);
    let changed = false;
    let blocked = false;
    const settledRows: string[] = [];
    const nextErrors = new Map(errors);

    for (const [name, draft] of drafts) {
      if (!committed.has(name)) {
        continue;
      }

      const rowName = draft.name.trim();
      const rowValues = parseValues(draft.values);
      const error = validate(
        rowName,
        rowValues,
        Array.from(next.keys()).filter((other) => other !== name)
      );
      if (error) {
        nextErrors.set(name, error);
        blocked = true;
        continue;
      }

      next = withRow(next, name, rowName, rowValues);
      settledRows.push(name);
      changed = true;
    }

    // An add row nobody typed into is not pending text. It is cleared of any message left by an
    // earlier explicit commit, since a message on an empty row would otherwise refuse every save
    // from then on with nothing the user could correct.
    const newName = newDraft.name.trim();
    const newValues = parseValues(newDraft.values);
    const newRowError = newRowHasText ? validate(newName, newValues, Array.from(next.keys()), true) : undefined;
    if (newRowError) {
      blocked = true;
      setNewError(newRowError);
    } else if (newRowHasText) {
      next = new Map(next).set(newName, newValues);
      changed = true;
      setNewDraft(EMPTY_DRAFT);
      setNewError(undefined);
      committedOnLeaveRef.current = false;
    } else {
      setNewError(undefined);
    }

    if (settledRows.length > 0 || nextErrors.size > 0) {
      setRowState((previous) => {
        const remaining = new Map(previous.drafts);
        settledRows.forEach((name) => remaining.delete(name));
        return { drafts: remaining, errors: nextErrors };
      });
    }

    if (changed) {
      onChange(Object.fromEntries(next));
    }

    return blocked ? 'blocked' : 'settled';
  };

  // The registration is made once per editor and calls whatever the latest render produced, so the
  // form settles the text as it stands at the moment it submits rather than as it stood when this
  // editor was opened.
  const commitScope = useContext(PlaylistVariablesCommitContext);
  const settleRef = useRef(settlePending);
  useEffect(() => {
    settleRef.current = settlePending;
  });
  useEffect(() => commitScope?.register(() => settleRef.current()), [commitScope]);

  const removeRow = (name: string) => {
    // The remove button unmounts with its row, and focus on an unmounted element falls to the
    // document body. Focus goes to the next row's remove button, which is the row that takes this
    // one's place on screen; the last row hands focus upwards instead, and the only row hands it to
    // the add row's name input. It is left alone when it was not on this button: a browser that
    // does not focus a button on click leaves focus somewhere real, which may be a caret in another
    // row's input, and that is the user's place rather than ours to move.
    const removeButton = rowControls.current.get(name)?.get('remove');
    if (removeButton && document.activeElement === removeButton) {
      const index = committedNames.indexOf(name);
      const neighbours = [committedNames[index + 1], committedNames[index - 1]];
      requestFocus({
        names: neighbours.filter((neighbour) => neighbour !== undefined),
        control: 'remove',
        fallbackToNewRow: true,
      });
    }

    clearRow(name);
    const next = new Map(entries);
    next.delete(name);
    // The playlist item stores "no variables" as an absent map rather than an empty one.
    onChange(next.size > 0 ? Object.fromEntries(next) : undefined);
  };

  /**
   * Records the element a commit is handing focus to, when there is one that can hold it.
   *
   * `relatedTarget` is an `EventTarget` and is `null` whenever the blur was not a move to another
   * element, so it is narrowed to an element rather than trusted to be one.
   */
  const recordCommitFocusTarget = (target: EventTarget | null) => {
    commitFocusTarget.current = target instanceof HTMLElement ? target : undefined;
  };

  // The two committed-row inputs are named after the variable they hold, which names them alike in
  // every editor of a dashboard this playlist lists more than once. Where the caller knows the
  // item's position, it is named too; where it does not, the names are exactly what they were.
  //
  // Every one of these names interpolates the free text the user typed as the variable name, and
  // escaping is turned off for those interpolations for the reason recorded at the remove control
  // below: the name is set as an attribute value, which is never parsed as HTML, and the escaped
  // spelling would disagree with the value shown in the input beside it.
  const nameFieldLabel = (variableName: string) =>
    itemPosition === undefined
      ? t('playlist-edit.form.variables-name-aria-label', 'Variable name for {{variableName}}', {
          variableName,
          interpolation: { escapeValue: false },
        })
      : t(
          'playlist-edit.form.variables-name-aria-label-item',
          'Variable name for {{variableName}}, item {{itemPosition}}',
          { variableName, itemPosition, interpolation: { escapeValue: false } }
        );

  const valuesFieldLabel = (variableName: string) =>
    itemPosition === undefined
      ? t('playlist-edit.form.variables-values-aria-label', 'Values for {{variableName}}', {
          variableName,
          interpolation: { escapeValue: false },
        })
      : t('playlist-edit.form.variables-values-aria-label-item', 'Values for {{variableName}}, item {{itemPosition}}', {
          variableName,
          itemPosition,
          interpolation: { escapeValue: false },
        });

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>, commit: () => void) => {
    if (event.key !== 'Enter') {
      return;
    }
    // This editor renders inside the playlist form's real <form>, where Enter in a text input
    // implicitly submits and would save the whole playlist mid-edit. Enter commits the row instead.
    event.preventDefault();
    event.stopPropagation();
    commit();
  };

  if (!withinBudget) {
    // Editing what cannot be represented would either drop variables the item still plays or
    // rebuild the whole map on every keystroke, so the item is left exactly as it is stored.
    return (
      <div className={styles.container}>
        <Alert
          severity="error"
          title={t('playlist-edit.form.variables-over-budget-title', 'These template variables cannot be edited')}
        >
          <Trans i18nKey="playlist-edit.form.variables-over-budget-body">
            The variables stored on this playlist item are beyond the limits the editor supports. Remove the playlist
            item and add it again to set its variables.
          </Trans>
        </Alert>
      </div>
    );
  }

  // The `maxLength` on the inputs below is a typing bound and nothing more: the DOM counts UTF-16
  // code units, so it stops an astral character after half as many of them as the limit allows and
  // cannot be made to count anything else. What decides acceptance is `validate` above, which
  // counts the Unicode code points the contract is stated in — and both bounds are set well past
  // their limit so that it, rather than the browser, is what answers text that is too long.
  return (
    <div className={styles.container}>
      <div className={styles.grid}>
        {displayOrder(entries).map(([name, values]) => {
          const draft = drafts.get(name) ?? draftFor(name, values);
          const error = errors.get(name);
          return (
            <Fragment key={name}>
              <Field
                noMargin
                className={styles.nameCell}
                invalid={error?.field === 'name'}
                error={error?.field === 'name' ? error.message : undefined}
              >
                <Input
                  ref={(element) => {
                    registerRowControl(name, 'name', element);
                  }}
                  value={draft.name}
                  maxLength={MAX_VARIABLE_NAME_TEXT_LENGTH}
                  aria-label={nameFieldLabel(name)}
                  placeholder={t('playlist-edit.form.variables-name-placeholder', 'Variable name')}
                  onChange={(event) => updateDraft(name, 'name', event.currentTarget.value)}
                  onBlur={(event) => {
                    // Where the blur is taking focus is where focus belongs after the commit, so it
                    // is recorded before the commit that may destroy the element it names.
                    recordCommitFocusTarget(event.relatedTarget);
                    commitRow(name);
                  }}
                  onKeyDown={(event) => {
                    // Enter commits without moving focus, so the input itself is where focus stays.
                    // Recorded only for the key that commits, so a keystroke that commits nothing
                    // leaves nothing behind.
                    if (event.key === 'Enter') {
                      recordCommitFocusTarget(event.currentTarget);
                    }
                    handleKeyDown(event, () => commitRow(name));
                  }}
                />
              </Field>
              <Field
                noMargin
                className={styles.valuesCell}
                invalid={error?.field === 'values'}
                error={error?.field === 'values' ? error.message : undefined}
              >
                <Input
                  ref={(element) => {
                    registerRowControl(name, 'values', element);
                  }}
                  value={draft.values}
                  maxLength={MAX_VARIABLE_VALUES_TEXT_LENGTH}
                  aria-label={valuesFieldLabel(name)}
                  placeholder={t('playlist-edit.form.variables-values-placeholder', 'Values, comma-separated')}
                  onChange={(event) => updateDraft(name, 'values', event.currentTarget.value)}
                  onBlur={(event) => {
                    recordCommitFocusTarget(event.relatedTarget);
                    commitRow(name);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      recordCommitFocusTarget(event.currentTarget);
                    }
                    handleKeyDown(event, () => commitRow(name));
                  }}
                />
              </Field>
              <IconButton
                // With a tooltip, IconButton hands the ref to Tooltip, which clones this element
                // with it — so what is registered is still the button node focus can be moved to.
                ref={(element) => {
                  registerRowControl(name, 'remove', element);
                }}
                type="button"
                name="times"
                size="md"
                className={styles.remove}
                onClick={() => removeRow(name)}
                /*
                 * The variable name is free text the user typed, and this tooltip and the two field
                 * names above interpolate such text. i18next escapes an interpolated value for
                 * HTML by default, which would name the control after the entity spelling of the
                 * name — `Remove variable it&#39;s` beside an input showing `it's` — so the
                 * accessible name and the value the user can see would disagree for any name
                 * holding one of & ' " < > /.
                 *
                 * Escaping is turned off for these interpolations rather than for the instance,
                 * because the default guards every other call site in the product: a t() result
                 * reaching HTML is escaped there and must stay so. It is safe to turn off here
                 * because React sets these strings as attribute values and renders the tooltip as
                 * a text node, and neither is ever parsed as HTML.
                 */
                tooltip={t('playlist-edit.form.variables-remove', 'Remove variable {{variableName}}', {
                  variableName: name,
                  interpolation: { escapeValue: false },
                })}
              />
            </Fragment>
          );
        })}

        {/*
         * The add row is introduced by a rule and a caption of its own because its two fields are
         * the only ones here with visible labels: directly under the last committed row, whose
         * inputs carry an `aria-label` and no label element, those labels otherwise read as
         * captions for the row above them.
         *
         * It is a styled text element and not a heading element: this editor renders inside the
         * row's `role="region"` panel, where an `h*` would enter the page's heading outline for a
         * control group. Nothing references it, so it is the accessible name of nothing and every
         * existing name in this panel is unchanged. The rule is dropped when no variable is
         * committed yet and the caption is the first thing in the grid, where it would divide the
         * fields from the panel's own padding rather than from anything.
         */}
        <div className={cx(styles.addCaption, { [styles.addCaptionDivided]: entries.length > 0 })}>
          <Text element="span" variant="h6">
            <Trans i18nKey="playlist-edit.form.variables-add-heading">Add a variable</Trans>
          </Text>
        </div>

        <Field
          noMargin
          className={styles.nameCell}
          label={t('playlist-edit.form.variables-new-name-label', 'Variable name')}
          invalid={newError?.field === 'name'}
          error={newError?.field === 'name' ? newError.message : undefined}
        >
          <Input
            // The one control here that no row owns, and so the place focus goes when the row that
            // held it was the last one on the item.
            ref={newNameInput}
            id={newNameId}
            value={newDraft.name}
            maxLength={MAX_VARIABLE_NAME_TEXT_LENGTH}
            placeholder={t('playlist-edit.form.variables-name-placeholder', 'Variable name')}
            onChange={(event) => updateNewDraft('name', event.currentTarget.value)}
            onBlur={handleNewRowBlur}
            onKeyDown={(event) => handleKeyDown(event, () => commitNewRow())}
          />
        </Field>
        <Field
          noMargin
          label={t('playlist-edit.form.variables-new-values-label', 'Values (comma-separated)')}
          invalid={newError?.field === 'values'}
          error={newError?.field === 'values' ? newError.message : undefined}
        >
          <Input
            id={newValuesId}
            value={newDraft.values}
            maxLength={MAX_VARIABLE_VALUES_TEXT_LENGTH}
            placeholder={t('playlist-edit.form.variables-values-placeholder', 'Values, comma-separated')}
            onChange={(event) => updateNewDraft('values', event.currentTarget.value)}
            onBlur={handleNewRowBlur}
            onKeyDown={(event) => handleKeyDown(event, () => commitNewRow())}
          />
        </Field>
        <div />

        <Button
          id={newAddId}
          className={styles.add}
          type="button"
          variant="secondary"
          size="sm"
          icon="plus"
          onClick={() => commitNewRow()}
        >
          <Trans i18nKey="playlist-edit.form.variables-add">Add variable</Trans>
        </Button>

        {/*
         * Text in these two fields is not yet part of the item, and the two things a user does
         * next — collapsing the panel and saving the playlist — both add it. Saying so while it is
         * being typed is what makes that predictable rather than something to discover afterwards,
         * and it is the only notice a row that cannot be added yet, such as a name with no values,
         * gets before it is refused. It shares the add button's cell so the note reads with the
         * control it is about, and so the grid the two sit in is unchanged when it appears.
         */}
        {newRowHasText && (
          <div className={styles.add}>
            <Text element="p" variant="bodySmall" color="secondary">
              <Trans i18nKey="playlist-edit.form.variables-pending-hint">
                This variable is not added yet. Select Add variable to include it.
              </Trans>
            </Text>
          </div>
        )}
      </div>
    </div>
  );
};

function getStyles(theme: GrafanaTheme2) {
  return {
    container: css({
      padding: theme.spacing(1),
      background: theme.colors.background.secondary,
      borderRadius: theme.shape.radius.default,
      border: `1px solid ${theme.colors.border.medium}`,
      marginBottom: '3px',
    }),
    grid: css({
      display: 'grid',
      // Two input columns and one column sized to the remove button. The values column is the
      // larger of the two because the two fields hold different amounts of text: a name is one
      // identifier, while the values beside it are a whole comma-separated list, so an even split
      // scrolls a list of three ordinary names out of sight while half the name field stays empty.
      // The tracks are minmax(0, …) and the items and their inputs are given a zero minimum
      // because a grid item, and every flex item inside Input, is otherwise floored at the text
      // field's intrinsic width — two of those plus the remove button overflow this already
      // indented panel.
      gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 3fr) auto',
      gap: theme.spacing(1),
      alignItems: 'start',
      '> *': {
        minWidth: 0,
      },
      input: {
        minWidth: 0,
      },
      [theme.breakpoints.down('sm')]: {
        // Narrower than this, two inputs beside each other leave neither of them typable, so the
        // name takes a line of its own and the values keep the width next to the remove button.
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        // Stacked, the fields of one variable and the fields of the next are the same list of
        // inputs, so distance is the only thing that says which values belong to which name: this
        // row gap holds a name tight against its own values, and `valuesCell` and `remove` add the
        // wider gap that ends the variable. The `gap` above still supplies the column gap.
        rowGap: theme.spacing(0.5),
      },
    }),
    nameCell: css({
      [theme.breakpoints.down('sm')]: {
        gridColumn: '1 / -1',
      },
    }),
    /**
     * Closes a committed variable when its fields are stacked: the values cell is the last cell of
     * the variable's second row, and a grid track is as tall as the tallest margin box in it, so
     * this margin and the matching one on `remove` are what separate one variable from the next.
     * With the tight row gap above, a variable's own fields sit 4 px apart and consecutive
     * variables 20 px apart, which is what makes each pair read as one variable. Only the
     * committed rows carry it — the add row is already delimited by its caption and rule.
     */
    valuesCell: css({
      [theme.breakpoints.down('sm')]: {
        marginBlockEnd: theme.spacing(2),
      },
    }),
    // Spans every column at both breakpoints, so the caption keeps its own line above the add
    // row's fields instead of taking the width of one of them.
    addCaption: css({
      gridColumn: '1 / -1',
    }),
    addCaptionDivided: css({
      borderBlockStart: `1px solid ${theme.colors.border.weak}`,
      // The grid's own gap sits above the rule and this padding below it, which keeps the caption
      // closer to the fields it introduces than to the committed row it is separated from.
      marginBlockStart: theme.spacing(1),
      paddingBlockStart: theme.spacing(1.5),
    }),
    remove: css({
      marginBlockStart: theme.spacing(0.5),
      [theme.breakpoints.down('sm')]: {
        // The other cell of the stacked variable's second row, so it repeats `valuesCell`'s
        // margin: the taller margin box would otherwise decide the track and the grouping gap
        // would depend on which of the two cells happened to be taller.
        marginBlockEnd: theme.spacing(2),
      },
    }),
    add: css({
      gridColumn: '1 / -1',
      justifySelf: 'start',
    }),
  };
}
