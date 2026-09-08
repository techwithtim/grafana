import { css } from '@emotion/css';
import { Fragment, type KeyboardEvent, useId, useState } from 'react';

import { type GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { Button, Field, IconButton, Input, useStyles2 } from '@grafana/ui';

interface Props {
  /**
   * Template variable values stored on the playlist item: a variable name mapped to one or more
   * values. An absent map means the item plays without variables.
   */
  variables?: Record<string, string[]>;
  /**
   * Receives a complete replacement map, or `undefined` once the last variable is removed. The
   * editor never mutates `variables`, which comes from the RTK Query cache.
   */
  onChange: (next?: Record<string, string[]>) => void;
}

/** The text a row currently shows, before it is normalized and committed. */
interface RowDraft {
  name: string;
  values: string;
}

/** A validation message plus the input it belongs to, so it renders under the offending input. */
interface RowError {
  field: 'name' | 'values';
  message: string;
}

const EMPTY_DRAFT: RowDraft = { name: '', values: '' };

/**
 * Splits the comma-separated values input into the list stored on the playlist item.
 *
 * This is the only place playlist variable values are parsed: the playlist runtime receives
 * ready-made lists and serializes them with `urlUtil.toUrlParams`, so no downstream code re-parses
 * user text. A single value containing a comma cannot be expressed this way, which is a documented
 * limitation of the editor rather than an oversight.
 */
function parseValues(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Edits the template variable values of one `dashboard_by_uid` playlist item.
 *
 * Each existing variable is one row of name and comma-separated values; the row below adds a new
 * variable. Rows are committed individually — on blur or Enter for existing rows, on the add button
 * or Enter for the new one — and a rejected row leaves the playlist item untouched.
 */
export const PlaylistItemVariables = ({ variables, onChange }: Props) => {
  const styles = useStyles2(getStyles);
  const newNameId = useId();
  const newValuesId = useId();

  const entries = Object.entries(variables ?? {});
  const committedNames = entries.map(([name]) => name);
  const nameSignature = committedNames.join('\u0000');

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [errors, setErrors] = useState<Record<string, RowError>>({});
  const [newDraft, setNewDraft] = useState<RowDraft>(EMPTY_DRAFT);
  const [newError, setNewError] = useState<RowError | undefined>(undefined);
  const [syncedNames, setSyncedNames] = useState(nameSignature);

  // Drafts and errors are keyed by the committed variable name the row was opened on. Once that set
  // of names changes — a rename, a removal, or an update from the parent — those keys no longer
  // identify the same rows, so pending state is dropped instead of re-attaching to another variable.
  if (syncedNames !== nameSignature) {
    setSyncedNames(nameSignature);
    setDrafts({});
    setErrors({});
  }

  const validate = (name: string, values: string[], otherNames: string[]): RowError | undefined => {
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
    if (otherNames.includes(name)) {
      return {
        field: 'name',
        message: t('playlist-edit.form.variables-name-duplicate', 'A variable with this name already exists'),
      };
    }
    return undefined;
  };

  const updateDraft = (name: string, draft: RowDraft) => {
    setDrafts((previous) => ({ ...previous, [name]: draft }));
    // Typing is how the user fixes a rejected row, so the message must not linger over new input.
    setErrors((previous) => {
      if (!previous[name]) {
        return previous;
      }
      const next = { ...previous };
      delete next[name];
      return next;
    });
  };

  const commitRow = (name: string) => {
    const draft = drafts[name];
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
      setErrors((previous) => ({ ...previous, [name]: error }));
      return;
    }

    const next: Record<string, string[]> = {};
    for (const [committedName, committedValues] of entries) {
      if (committedName === name) {
        // Replacing the key in place keeps a renamed variable at its position in the list.
        next[nextName] = nextValues;
      } else {
        next[committedName] = committedValues;
      }
    }
    onChange(next);
  };

  const commitNewRow = () => {
    const name = newDraft.name.trim();
    const values = parseValues(newDraft.values);
    const error = validate(name, values, committedNames);
    if (error) {
      setNewError(error);
      return;
    }

    setNewError(undefined);
    setNewDraft(EMPTY_DRAFT);
    onChange({ ...variables, [name]: values });
  };

  const removeRow = (name: string) => {
    const next = Object.fromEntries(entries.filter(([committedName]) => committedName !== name));
    // The playlist item stores "no variables" as an absent map rather than an empty one.
    onChange(Object.keys(next).length > 0 ? next : undefined);
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

  return (
    <div className={styles.container}>
      {/* One grid for every row, so the name and values columns line up across all rows including
          the add row, whose third cell is empty because it has no remove button. */}
      <div className={styles.grid}>
        {entries.map(([name, values]) => {
          const draft = drafts[name] ?? { name, values: values.join(', ') };
          const error = errors[name];
          return (
            <Fragment key={name}>
              <Field
                noMargin
                invalid={error?.field === 'name'}
                error={error?.field === 'name' ? error.message : undefined}
              >
                <Input
                  value={draft.name}
                  aria-label={t('playlist-edit.form.variables-name-aria-label', 'Variable name for {{variableName}}', {
                    variableName: name,
                  })}
                  placeholder={t('playlist-edit.form.variables-name-placeholder', 'Variable name')}
                  onChange={(event) => updateDraft(name, { ...draft, name: event.currentTarget.value })}
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
                  aria-label={t('playlist-edit.form.variables-values-aria-label', 'Values for {{variableName}}', {
                    variableName: name,
                  })}
                  placeholder={t('playlist-edit.form.variables-values-placeholder', 'Values, comma-separated')}
                  onChange={(event) => updateDraft(name, { ...draft, values: event.currentTarget.value })}
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
          label={t('playlist-edit.form.variables-new-name-label', 'Variable name')}
          invalid={newError?.field === 'name'}
          error={newError?.field === 'name' ? newError.message : undefined}
        >
          <Input
            id={newNameId}
            value={newDraft.name}
            placeholder={t('playlist-edit.form.variables-name-placeholder', 'Variable name')}
            onChange={(event) => {
              setNewDraft({ ...newDraft, name: event.currentTarget.value });
              setNewError(undefined);
            }}
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
            placeholder={t('playlist-edit.form.variables-values-placeholder', 'Values, comma-separated')}
            onChange={(event) => {
              setNewDraft({ ...newDraft, values: event.currentTarget.value });
              setNewError(undefined);
            }}
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
      // Two equal input columns and one column sized to the remove button.
      gridTemplateColumns: '1fr 1fr auto',
      gap: theme.spacing(1),
      alignItems: 'start',
    }),
    remove: css({
      // Lines the button up with the input beside it rather than the top of the cell.
      marginBlockStart: theme.spacing(0.5),
    }),
    add: css({
      gridColumn: '1 / -1',
      justifySelf: 'start',
    }),
  };
}
