import { css } from '@emotion/css';
import { isEqual } from 'lodash';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import tinycolor from 'tinycolor2';

import { type GrafanaTheme2, rangeUtil } from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors';
import { Trans, t } from '@grafana/i18n';
import { config } from '@grafana/runtime';
import { Box, Button, Field, FieldSet, Input, LinkButton, Stack, useStyles2 } from '@grafana/ui';
import { type RepositoryView } from 'app/api/clients/provisioning/v0alpha1';
import { Form } from 'app/core/components/Form/Form';
import { FormPrompt } from 'app/core/components/FormPrompt/FormPrompt';
import { DashboardPicker } from 'app/core/components/Select/DashboardPicker';
import { TagFilter } from 'app/core/components/TagFilter/TagFilter';
import { RepositorySelect } from 'app/features/provisioning/components/Shared/RepositorySelect';
import { getManagerIdentity, isManagedByRepository } from 'app/features/provisioning/utils/managedResource';

import { type Playlist, type PlaylistSpec } from '../../api/clients/playlist/v1';
import { getGrafanaSearcher } from '../search/service/searcher';

import {
  MIN_HIT_TARGET_SIZE,
  PlaylistVariablesCommitContext,
  usePlaylistVariablesCommit,
} from './PlaylistItemVariables';
import { PlaylistTable } from './PlaylistTable';
import { type PlaylistItemUI } from './types';
import { usePlaylistItems } from './usePlaylistItems';

/**
 * The API shape of the edited item list. `dashboards` is UI-only state loaded at runtime, and an
 * empty or undefined variables map is omitted rather than submitted, so an item without template
 * variables keeps the variable-less API payload shape.
 *
 * Used both for what is submitted and for comparing the edited list against the loaded one, so the
 * unsaved-changes guard can never disagree with the payload about what "changed" means.
 */
function toApiItems(
  items: PlaylistItemUI[],
  settledVariables?: Map<number, Record<string, string[]> | undefined>
): PlaylistSpec['items'] {
  return items.map(({ dashboards, variables, ...item }, index) => {
    const itemVariables = settledVariables?.has(index) ? settledVariables.get(index) : variables;
    return itemVariables && Object.keys(itemVariables).length > 0 ? { ...item, variables: itemVariables } : item;
  });
}

/**
 * `required` is satisfied by any non-empty string, so a name of nothing but spaces used to be
 * accepted and stored: the list then showed a card with no visible name, and its delete
 * confirmation had no name to name. The name is submitted trimmed (see `doSubmit`), so this is also
 * what keeps the value that is validated and the value that is stored the same one.
 */
function validateTitle(value: string | undefined): true | string {
  return (value ?? '').trim().length > 0
    ? true
    : t('playlist-edit.form.name-blank', 'Name cannot consist only of spaces');
}

/**
 * The interval is validated with the parser playback itself uses: `PlaylistSrv.start` turns the
 * saved string into a delay with `rangeUtil.intervalToMs`, which throws on anything the interval
 * grammar does not recognise. An interval the editor accepted but that parser rejects produces a
 * playlist that cannot be played at all, so the editor accepts exactly what playback accepts —
 * `5m`, `90s`, `1h`, and a unit-less number as seconds — and nothing else.
 */
function validateInterval(value: string | undefined): true | string {
  try {
    rangeUtil.intervalToMs(value ?? '');
    return true;
  } catch {
    return t('playlist-edit.form.interval-invalid', 'Interval must be a duration such as 30s, 5m or 1h');
  }
}

/**
 * The tag filter is an "add by tag" trigger here and holds no selected tags of its own. The empty
 * list is a module constant rather than a literal in the markup because `TagFilter` compares this
 * prop by reference and re-queries the dashboard tag facets whenever its identity changes, so a new
 * `[]` on every render made each structural edit of the item list issue redundant search requests.
 */
const noSelectedTags: string[] = [];

/**
 * What the Save control is answering for: the state of the save itself, not of one field.
 *
 * `saving` is a request already in flight, `no-items` a playlist with nothing to play, and
 * `invalid-fields` a name or interval the form has rejected. `available` is the only value that
 * lets a save through.
 */
type SaveState = 'available' | 'saving' | 'no-items' | 'invalid-fields';

interface SaveConditions {
  /** A save already running. Read from the synchronous flag as well as the rendered state. */
  busy: boolean;
  itemCount: number;
  invalidFieldCount: number;
}

/**
 * The one place the Save control's availability is decided.
 *
 * The button renders from this and the submit re-checks it, because the two used to disagree: the
 * button carried the native `disabled` attribute — which `Button` pairs with `aria-disabled="false"`
 * whenever it has no tooltip to keep reachable — while the submit itself trusted the attribute to
 * have stopped everything, so a save that got past the attribute had nothing left to refuse it.
 *
 * Ordered by what the user has to do about it, most immediate first, so the one reason reported is
 * the one that is actionable now.
 */
function describeSaveState({ busy, itemCount, invalidFieldCount }: SaveConditions): SaveState {
  if (busy) {
    return 'saving';
  }
  if (itemCount === 0) {
    return 'no-items';
  }
  if (invalidFieldCount > 0) {
    return 'invalid-fields';
  }
  return 'available';
}

/**
 * What the Save control says about the state it is in, on hover, on focus, and — for a save it
 * refuses — in the form's live region.
 *
 * Every state has text, including `available`: the tooltip is what turns `Button`'s
 * `aria-disabled` path on, which is what keeps the control focusable and its reason reachable
 * instead of leaving an inert element that reports itself as enabled. Supplying the tooltip in
 * every state also keeps the rendered element the same one across a state change — `Button` wraps
 * itself in `Tooltip` only when it has one, and a control that gains or loses that wrapper is
 * remounted, which would drop the focus of the user who had just activated it.
 */
function saveStateMessage(state: SaveState): string {
  switch (state) {
    case 'saving':
      return t('playlist-edit.form.save-state-saving', 'Saving this playlist');
    case 'no-items':
      return t('playlist-edit.form.save-state-no-items', 'Add at least one dashboard before saving');
    case 'invalid-fields':
      return t('playlist-edit.form.save-state-invalid-fields', 'Correct the fields marked with an error before saving');
    case 'available':
      return t('playlist-edit.form.save-state-available', 'Save this playlist');
  }
}

interface Props {
  onSubmit: (playlist: Playlist) => void | Promise<void>;
  playlist: Playlist;
  showRepositorySelect?: boolean;
  repositories?: RepositoryView[];
  /** Selected repository name. Empty string = "no repository" (save to Grafana). */
  selectedRepository?: string;
  onRepositoryChange?: (repositoryName: string) => void;
  /**
   * Locks the repository selector (the repository can't be changed after creation). The displayed
   * value is then derived from the playlist itself rather than `selectedRepository`.
   */
  disableRepositorySelect?: boolean;
}

export const PlaylistForm = ({
  onSubmit,
  playlist,
  showRepositorySelect,
  repositories = [],
  selectedRepository,
  onRepositoryChange,
  disableRepositorySelect,
}: Props) => {
  const styles = useStyles2(getStyles);
  const [saving, setSaving] = useState(false);
  const playlistNameId = useId();
  const playlistIntervalId = useId();
  const { title: name, interval, items: propItems } = playlist.spec || {};
  const tagOptions = useMemo(() => {
    return () => getGrafanaSearcher().tags({ kind: ['dashboard'] });
  }, []);

  const { items, addByUID, addByTag, deleteItem, moveItem, updateItemVariables } = usePlaylistItems(propItems);
  const { commitScope, settlePendingVariables } = usePlaylistVariablesCommit();

  /**
   * Where a variable editor's last-moment commit is recorded, for the one submit that asked for it.
   *
   * Settling happens inside the submit, and the item list `doSubmit` reads belongs to the render
   * that submit started from — a commit made now reaches the next render, which is after the
   * playlist has already been sent. Recording what the editors commit is what lets that submit
   * carry it. Outside a submit the reference holds nothing and this is an ordinary update.
   */
  const settledVariablesRef = useRef<Map<number, Record<string, string[]> | undefined> | undefined>(undefined);

  const applyItemVariables = useCallback(
    (index: number, variables?: Record<string, string[]>) => {
      settledVariablesRef.current?.set(index, variables);
      updateItemVariables(index, variables);
    },
    [updateItemVariables]
  );

  const repositoryFieldValue = disableRepositorySelect
    ? isManagedByRepository(playlist)
      ? (getManagerIdentity(playlist) ?? '')
      : ''
    : selectedRepository;

  const apiItems = useMemo(() => toApiItems(items), [items]);

  // The item list lives outside react-hook-form, so it is compared against the playlist that was
  // loaded. Both sides go through `toApiItems`, which drops the asynchronously loaded `dashboards`
  // — the only property enrichment adds — so neither enrichment nor a variables map the API omitted
  // can make an untouched list look edited.
  const itemsDirty = useMemo(() => !isEqual(apiItems, toApiItems(propItems ?? [])), [apiItems, propItems]);

  // Set synchronously in `doSubmit` before anything can await, and read by the unsaved-changes
  // guard: the pages navigate to the playlist list from inside the `onSubmit` this awaits, and that
  // navigation must never be mistaken for the user leaving with unsaved work. A state flag would
  // not be visible until the next render, which is too late.
  const submitInFlight = useRef(false);

  /**
   * The last refused save, as the form's live region announces it.
   *
   * A refusal used to be silent: the save stopped, nothing moved, and the only sign was a message
   * inside a panel that may be scrolled out of view. The serial is what makes the same refusal
   * announceable twice — a live region re-reads a child it did not have before, and identical text
   * in the same node is not a change — and it is the announcement's key for exactly that reason.
   */
  const [refusedSave, setRefusedSave] = useState<{ serial: number; message: string } | undefined>(undefined);

  const announceRefusedSave = useCallback((message: string) => {
    setRefusedSave((previous) => ({ serial: (previous?.serial ?? 0) + 1, message }));
  }, []);

  /**
   * The inputs `describeSaveState` decides on, gathered in one place so the button and the submit
   * guard cannot drift apart on what "the same conditions" means.
   *
   * `invalidFieldCount` is the caller's to supply because only the render has react-hook-form's
   * errors in hand, and only the submit knows they have just been re-validated.
   */
  const saveConditions = (invalidFieldCount: number): SaveConditions => ({
    // The ref is the synchronous half of `saving`: a second activation can reach the submit handler
    // before the render that would have shown the button as busy, and each save creates its own
    // playlist.
    busy: saving || submitInFlight.current,
    itemCount: items.length,
    invalidFieldCount,
  });

  const doSubmit = async (specUpdates: Playlist['spec']) => {
    // Save reports `aria-disabled` rather than carrying the native `disabled` attribute, so that
    // the reason it is unavailable stays reachable — and it is this form's submit control, which
    // means a click or Enter on an unavailable Save still reaches here through the browser's own
    // submit. This is what refuses it, from the same value the button renders from.
    //
    // No field can be invalid at this point: `Form` submits through react-hook-form's
    // `handleSubmit`, which validates every field first, calls this only for a valid form, and
    // focuses the first offending field itself when it is not. The two conditions it knows nothing
    // about — an empty item list and a save already in flight — are the ones re-checked.
    const state = describeSaveState(saveConditions(0));
    if (state !== 'available') {
      announceRefusedSave(saveStateMessage(state));
      return;
    }

    // Text typed into a variable editor and not yet added is part of what the user is saving, so
    // it is committed here before anything is sent. An editor that refuses it — an empty value, a
    // duplicated name — has put its message on screen and this save stops: going ahead would store
    // the value the user had just replaced and report that as a success.
    const settled = new Map<number, Record<string, string[]> | undefined>();
    settledVariablesRef.current = settled;
    const maySave = settlePendingVariables();
    settledVariablesRef.current = undefined;
    if (!maySave) {
      // The editor that refused has marked its own field and taken focus to it, so what is
      // announced here is the one thing it cannot say: that the playlist was not saved. Which
      // variable is wrong, and why, is on the field the user has just been moved to.
      announceRefusedSave(
        t(
          'playlist-edit.form.save-refused-variables',
          'Playlist not saved. Complete or remove the template variable marked with an error, then save again.'
        )
      );
      return;
    }

    setRefusedSave(undefined);
    submitInFlight.current = true;
    setSaving(true);
    // What the editors settled is overlaid on the memoised payload: settling commits to the next
    // render, which is after this submit has already sent the playlist, so the values collected
    // above are the only ones this save can carry.
    const submittedItems = settled.size > 0 ? toApiItems(items, settled) : apiItems;
    try {
      // The direct-save path navigates away; the provisioned path returns after opening the drawer,
      // so reset `saving` here or the Save button would keep spinning behind the drawer.
      await onSubmit({
        ...playlist,
        spec: {
          ...specUpdates,
          interval: specUpdates?.interval ?? '5m',
          // Trimmed here rather than in the field so the editor keeps showing what was typed:
          // surrounding whitespace is not part of a playlist's name, and storing it would leave a
          // name that renders as blank in the list and in the delete confirmation.
          title: specUpdates?.title?.trim() ?? '',
          items: submittedItems,
        },
      });
    } finally {
      submitInFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <Form<PlaylistSpec> onSubmit={doSubmit} validateOn={'onBlur'}>
      {({ register, errors, formState, reset }) => {
        // The one value the Save control presents and the submit refuses from. It is not a second
        // opinion about validity: `doSubmit` runs `describeSaveState` over the same conditions.
        const saveState = describeSaveState(saveConditions(Object.keys(errors).length));
        return (
          <>
            <FormPrompt
              confirmRedirect={formState.isDirty || itemsDirty}
              // Discarding happens as the page unmounts, so returning the form fields to their
              // loaded values is all that is left to do; the item list goes with the component.
              onDiscard={reset}
              // Returning false disables the block for one navigation, which is exactly what a save
              // that navigates on success needs.
              onLocationChange={() => !submitInFlight.current}
            />
            <Field
              label={t('playlist-edit.form.name-label', 'Name')}
              invalid={!!errors.title}
              error={errors?.title?.message}
            >
              <Input
                type="text"
                {...register('title', {
                  required: t('playlist-edit.form.name-required', 'Name is required'),
                  validate: validateTitle,
                })}
                placeholder={t('playlist-edit.form.name-placeholder', 'Name')}
                defaultValue={name}
                data-testid={selectors.pages.PlaylistForm.name}
                id={playlistNameId}
              />
            </Field>
            <Field
              label={t('playlist-edit.form.interval-label', 'Interval')}
              invalid={!!errors.interval}
              error={errors?.interval?.message}
            >
              <Input
                type="text"
                {...register('interval', {
                  required: t('playlist-edit.form.interval-required', 'Interval is required'),
                  validate: validateInterval,
                })}
                placeholder={t('playlist-edit.form.interval-placeholder', '5m')}
                defaultValue={interval ?? '5m'}
                data-testid={selectors.pages.PlaylistForm.interval}
                id={playlistIntervalId}
              />
            </Field>

            {showRepositorySelect && (
              // RepositorySelect uses noMargin (shared component); add bottom spacing to match the
              // surrounding fields and keep it from butting against the "Add dashboards" section.
              <Box marginBottom={2}>
                <RepositorySelect
                  repositories={repositories}
                  value={repositoryFieldValue}
                  onChange={onRepositoryChange ?? (() => {})}
                  readOnly={disableRepositorySelect}
                />
              </Box>
            )}

            {/*
              The scope is what connects the variable editors — one per expanded row, rendered
              inside the table — to this form's submit, so text typed into one is settled before
              the playlist is sent rather than dropped by it.
            */}
            <PlaylistVariablesCommitContext.Provider value={commitScope}>
              <PlaylistTable
                items={items}
                deleteItem={deleteItem}
                moveItem={moveItem}
                onVariablesChange={applyItemVariables}
              />
            </PlaylistVariablesCommitContext.Provider>

            <FieldSet label={t('playlist-edit.form.heading', 'Add dashboards')}>
              <Field label={t('playlist-edit.form.add-title-label', 'Add by title')}>
                {/*
                 * Deliberately not keyed on the item count: remounting the picker on every add or
                 * delete unmounted the focused input (dropping keyboard focus to `document.body`)
                 * and re-ran its mount-only dashboard and tag searches. `clearOnSelect` returns the
                 * control to its placeholder in place instead, which is what the remount used to do.
                 */}
                <DashboardPicker id="dashboard-picker" onChange={addByUID} clearOnSelect />
              </Field>

              <Field label={t('playlist-edit.form.add-tag-label', 'Add by tag')}>
                <TagFilter
                  isClearable
                  tags={noSelectedTags}
                  hideValues
                  tagOptions={tagOptions}
                  onChange={addByTag}
                  placeholder={t('playlist-edit.form.add-tag-placeholder', 'Select a tag')}
                />
              </Field>
            </FieldSet>

            {/*
              Where a refused save is announced. It is rendered in every state, empty until there
              is something to say, because a live region has to be in the document before the text
              appears in it — one inserted together with its message is not a change to a region
              and is not announced. `sr-only` because everything announced here is either visible
              on the control itself (its tooltip) or on the field the refusal moved focus to.
            */}
            <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {refusedSave && <span key={refusedSave.serial}>{refusedSave.message}</span>}
            </div>

            <Stack>
              <Button
                type="submit"
                variant="primary"
                className={styles.saveButton}
                disabled={saveState !== 'available'}
                // Given in every state, which is what makes `Button` report `aria-disabled` and
                // drop the native attribute: an unavailable Save then stays focusable and
                // hoverable, so the reason travels with the control instead of being something the
                // user has to deduce from a dead button. It is also what keeps this element from
                // being remounted — and its focus dropped — as the state changes.
                tooltip={saveStateMessage(saveState)}
                // The spinner alone conveys the in-flight save visually; `aria-busy` conveys it to
                // assistive technology, which does not otherwise hear that the button is waiting.
                aria-busy={saving}
                icon={saving ? 'spinner' : undefined}
              >
                <Trans i18nKey="playlist-edit.form.save">Save</Trans>
              </Button>
              <LinkButton variant="secondary" className={styles.cancelButton} href={`${config.appSubUrl}/playlists`}>
                <Trans i18nKey="playlist-edit.form.cancel">Cancel</Trans>
              </LinkButton>
            </Stack>
          </>
        );
      }}
    </Form>
  );
};

/**
 * How far the hover, focus and pressed fills of the form's primary button are taken from
 * `theme.colors.primary.main`, in HSL lightness percentage points.
 *
 * `Button` paints `variant="primary" fill="solid"` as `primary.main` at rest and `primary.shade`
 * while hovered or focused [packages/grafana-ui/src/components/Button/Button.tsx:406-426], and
 * `shade` is derived by *lightening* `main` on a dark theme [createColors.ts:372-374]. White
 * `primary.contrastText` on that lighter fill measures 3.55:1 — below the 4.5:1 that normal text
 * needs — while the rest state measures 4.61:1, so the button lost contrast exactly when the
 * pointer or the keyboard reached it.
 *
 * Taking the fill the other way keeps a visible state change and raises the ratio in both themes:
 * white measures 6.10:1 on the hover fill and 7.95:1 on the pressed one. The two steps are far
 * enough apart to read as rest -> hover -> pressed rather than as one flattened colour, and small
 * enough that the button still reads as the same primary control. The values are derived from the
 * theme token rather than written as hex so a re-themed `primary.main` carries them with it.
 */
const HOVER_FILL_DARKEN = 8;
const PRESSED_FILL_DARKEN = 16;

function getStyles(theme: GrafanaTheme2) {
  /**
   * The 44 px box both form buttons offer a pointer. A `size="md"` `Button` is 32 px tall, so it
   * was 12 px short of it. `Button` is an `inline-flex` that centres its content, so the minima are
   * the whole change and the label keeps its own size; `justifyContent` only matters for a label
   * narrower than the box, which is not the case for either of these two but is what makes the
   * rule correct rather than incidentally right.
   */
  const hitTarget = {
    minWidth: MIN_HIT_TARGET_SIZE,
    minHeight: MIN_HIT_TARGET_SIZE,
    justifyContent: 'center',
  };

  return {
    /**
     * The form's Save button.
     *
     * `Button` composes `cx(styles.button, { [styles.disabled]: disabled }, className)`, so a
     * caller's class is merged last and wins for the declarations it repeats. Only the fills of the
     * states a user can reach are repeated here: the unavailable state keeps the component's own
     * disabled fill, whose text is exempt from the contrast requirement, which is why these rules
     * are withheld from a control carrying either form of the disabled signal.
     */
    saveButton: css({
      ...hitTarget,
      "&:not([disabled]):not([aria-disabled='true'])": {
        '&:hover, &:focus, &:focus-visible': {
          background: tinycolor(theme.colors.primary.main).darken(HOVER_FILL_DARKEN).toString(),
        },
        // Declared after hover so the pressed fill is what shows while the pointer is both over
        // the button and held down, which is the only way a pointer reaches this state.
        '&:active': {
          background: tinycolor(theme.colors.primary.main).darken(PRESSED_FILL_DARKEN).toString(),
        },
      },
    }),
    /**
     * The form's Cancel link.
     *
     * Only the box: `LinkButton`'s secondary fills already carry their text at 7:1 or better in
     * both themes, in every state, so there is nothing here to correct about its colours.
     */
    cancelButton: css(hitTarget),
  };
}
