import { isEqual } from 'lodash';
import { useCallback, useId, useMemo, useRef, useState } from 'react';

import { selectors } from '@grafana/e2e-selectors';
import { Trans, t } from '@grafana/i18n';
import { config } from '@grafana/runtime';
import { Box, Button, Field, FieldSet, Input, LinkButton, Stack } from '@grafana/ui';
import { type RepositoryView } from 'app/api/clients/provisioning/v0alpha1';
import { Form } from 'app/core/components/Form/Form';
import { FormPrompt } from 'app/core/components/FormPrompt/FormPrompt';
import { DashboardPicker } from 'app/core/components/Select/DashboardPicker';
import { TagFilter } from 'app/core/components/TagFilter/TagFilter';
import { RepositorySelect } from 'app/features/provisioning/components/Shared/RepositorySelect';
import { getManagerIdentity, isManagedByRepository } from 'app/features/provisioning/utils/managedResource';

import { type Playlist, type PlaylistSpec } from '../../api/clients/playlist/v1';
import { getGrafanaSearcher } from '../search/service/searcher';

import { PlaylistVariablesCommitContext, usePlaylistVariablesCommit } from './PlaylistItemVariables';
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
 * The tag filter is an "add by tag" trigger here and holds no selected tags of its own. The empty
 * list is a module constant rather than a literal in the markup because `TagFilter` compares this
 * prop by reference and re-queries the dashboard tag facets whenever its identity changes, so a new
 * `[]` on every render made each structural edit of the item list issue redundant search requests.
 */
const noSelectedTags: string[] = [];

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

  const doSubmit = async (specUpdates: Playlist['spec']) => {
    // Text typed into a variable editor and not yet added is part of what the user is saving, so
    // it is committed here before anything is sent. An editor that refuses it — an empty value, a
    // duplicated name — has put its message on screen and this save stops: going ahead would store
    // the value the user had just replaced and report that as a success.
    const settled = new Map<number, Record<string, string[]> | undefined>();
    settledVariablesRef.current = settled;
    const maySave = settlePendingVariables();
    settledVariablesRef.current = undefined;
    if (!maySave) {
      return;
    }

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
          title: specUpdates?.title ?? '',
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
        // `saving` is part of the condition so a second click cannot start a second save while the
        // first request is still in flight — each one would create an independent playlist.
        const isDisabled = saving || items.length === 0 || Object.keys(errors).length > 0;
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
                {...register('title', { required: t('playlist-edit.form.name-required', 'Name is required') })}
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

            <Stack>
              <Button
                type="submit"
                variant="primary"
                disabled={isDisabled}
                // The spinner alone conveys the in-flight save visually; `aria-busy` conveys it to
                // assistive technology, which does not otherwise hear that the button is waiting.
                aria-busy={saving}
                icon={saving ? 'spinner' : undefined}
              >
                <Trans i18nKey="playlist-edit.form.save">Save</Trans>
              </Button>
              <LinkButton variant="secondary" href={`${config.appSubUrl}/playlists`}>
                <Trans i18nKey="playlist-edit.form.cancel">Cancel</Trans>
              </LinkButton>
            </Stack>
          </>
        );
      }}
    </Form>
  );
};
