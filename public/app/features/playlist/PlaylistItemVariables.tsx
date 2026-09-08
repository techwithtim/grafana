import { css } from '@emotion/css';
import { Fragment, type KeyboardEvent, useId, useState } from 'react';

import { type GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { Alert, Button, Field, IconButton, Input, useStyles2 } from '@grafana/ui';

import {
  MAX_VALUES_PER_VARIABLE,
  MAX_VARIABLE_NAME_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  MAX_VARIABLE_VALUES_TEXT_LENGTH,
  MAX_VARIABLES_PER_ITEM,
  isWithinCodePointLimit,
  isWithinVariableBudget,
} from './variableLimits';

interface Props {
  variables?: Record<string, string[]>;
  /**
   * Receives a complete replacement map, or `undefined` once the last variable is removed. The
   * editor never mutates `variables`: that map belongs to the caller, and may be a value held in
   * an RTK Query cache entry.
   */
  onChange: (next?: Record<string, string[]>) => void;
}

type RowField = 'name' | 'values';

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

export const PlaylistItemVariables = ({ variables, onChange }: Props) => {
  const styles = useStyles2(getStyles);
  const newNameId = useId();
  const newValuesId = useId();

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

  // Reconciling against the committed names as they arrive, rather than in an effect, means the
  // rows below already read the reconciled state; the write only carries it into the next render.
  const { drafts, errors } = reconcileRows(rowState, committed);
  if (rowState.drafts !== drafts) {
    setRowState({ drafts, errors });
  }

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

    const next = new Map<string, string[]>();
    for (const [committedName, committedValues] of committed) {
      next.set(
        committedName === name ? nextName : committedName,
        committedName === name ? nextValues : committedValues
      );
    }
    onChange(Object.fromEntries(next));
  };

  const updateNewDraft = (field: RowField, value: string) => {
    setNewDraft((previous) => (field === 'name' ? { ...previous, name: value } : { ...previous, values: value }));
    setNewError((previous) => (previous?.field === field ? undefined : previous));
  };

  const commitNewRow = () => {
    const name = newDraft.name.trim();
    const values = parseValues(newDraft.values);
    const error = validate(name, values, committedNames, true);
    if (error) {
      setNewError(error);
      return;
    }

    setNewError(undefined);
    setNewDraft(EMPTY_DRAFT);
    // Building the map through Object.fromEntries defines every name as an own property of the
    // result. Assigning one would let a variable named `__proto__` rewrite the map's prototype
    // instead of appearing in it, losing the variable the user just added.
    onChange(Object.fromEntries(new Map(entries).set(name, values)));
  };

  const removeRow = (name: string) => {
    clearRow(name);
    const next = new Map(entries);
    next.delete(name);
    // The playlist item stores "no variables" as an absent map rather than an empty one.
    onChange(next.size > 0 ? Object.fromEntries(next) : undefined);
  };

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

  // The `maxLength` on the inputs below is a conservative typing bound and nothing more: the DOM
  // counts UTF-16 code units, so it stops an astral character after half as many of them as the
  // limit allows and cannot be made to count anything else. What decides acceptance is `validate`
  // above, which counts the Unicode code points the contract is stated in.
  return (
    <div className={styles.container}>
      <div className={styles.grid}>
        {entries.map(([name, values]) => {
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
                  value={draft.name}
                  maxLength={MAX_VARIABLE_NAME_LENGTH}
                  aria-label={t('playlist-edit.form.variables-name-aria-label', 'Variable name for {{variableName}}', {
                    variableName: name,
                  })}
                  placeholder={t('playlist-edit.form.variables-name-placeholder', 'Variable name')}
                  onChange={(event) => updateDraft(name, 'name', event.currentTarget.value)}
                  onBlur={() => commitRow(name)}
                  onKeyDown={(event) => handleKeyDown(event, () => commitRow(name))}
                />
              </Field>
              <Field
                noMargin
                invalid={error?.field === 'values'}
                error={error?.field === 'values' ? error.message : undefined}
              >
                <Input
                  value={draft.values}
                  maxLength={MAX_VARIABLE_VALUES_TEXT_LENGTH}
                  aria-label={t('playlist-edit.form.variables-values-aria-label', 'Values for {{variableName}}', {
                    variableName: name,
                  })}
                  placeholder={t('playlist-edit.form.variables-values-placeholder', 'Values, comma-separated')}
                  onChange={(event) => updateDraft(name, 'values', event.currentTarget.value)}
                  onBlur={() => commitRow(name)}
                  onKeyDown={(event) => handleKeyDown(event, () => commitRow(name))}
                />
              </Field>
              <IconButton
                type="button"
                name="times"
                size="md"
                className={styles.remove}
                onClick={() => removeRow(name)}
                tooltip={t('playlist-edit.form.variables-remove', 'Remove variable {{variableName}}', {
                  variableName: name,
                })}
              />
            </Fragment>
          );
        })}

        <Field
          noMargin
          className={styles.nameCell}
          label={t('playlist-edit.form.variables-new-name-label', 'Variable name')}
          invalid={newError?.field === 'name'}
          error={newError?.field === 'name' ? newError.message : undefined}
        >
          <Input
            id={newNameId}
            value={newDraft.name}
            maxLength={MAX_VARIABLE_NAME_LENGTH}
            placeholder={t('playlist-edit.form.variables-name-placeholder', 'Variable name')}
            onChange={(event) => updateNewDraft('name', event.currentTarget.value)}
            onKeyDown={(event) => handleKeyDown(event, commitNewRow)}
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
            onKeyDown={(event) => handleKeyDown(event, commitNewRow)}
          />
        </Field>
        <div />

        <Button className={styles.add} type="button" variant="secondary" size="sm" icon="plus" onClick={commitNewRow}>
          <Trans i18nKey="playlist-edit.form.variables-add">Add variable</Trans>
        </Button>
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
      // Two equal input columns and one column sized to the remove button. The tracks are
      // minmax(0, …) and the items and their inputs are given a zero minimum because a grid item,
      // and every flex item inside Input, is otherwise floored at the text field's intrinsic
      // width — two of those plus the remove button overflow this already indented panel.
      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto',
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
      },
    }),
    nameCell: css({
      [theme.breakpoints.down('sm')]: {
        gridColumn: '1 / -1',
      },
    }),
    remove: css({
      marginBlockStart: theme.spacing(0.5),
    }),
    add: css({
      gridColumn: '1 / -1',
      justifySelf: 'start',
    }),
  };
}
