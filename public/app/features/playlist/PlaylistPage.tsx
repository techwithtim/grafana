import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Trans, t } from '@grafana/i18n';
import { Alert, ConfirmModal, EmptyState, LinkButton, TextLink } from '@grafana/ui';
import { Page } from 'app/core/components/Page/Page';
import PageActionBar from 'app/core/components/PageActionBar/PageActionBar';
import { useUrlParams } from 'app/core/navigation/hooks';
import { PreviewBannerViewPR } from 'app/features/provisioning/components/Shared/PreviewBannerViewPR';
import { SaveProvisionedResourceDrawer } from 'app/features/provisioning/components/Shared/SaveProvisionedResourceDrawer';
import { usePullRequestParam } from 'app/features/provisioning/hooks/usePullRequestParam';
import { isManagedByRepository } from 'app/features/provisioning/utils/managedResource';

import { type Playlist, useDeletePlaylistMutation, useListPlaylistQuery } from '../../api/clients/playlist/v1';

import { PlaylistPageList } from './PlaylistPageList';
import { StartModal } from './StartModal';
import { searchPlaylists, useCanWritePlaylists } from './utils';

export const PlaylistPage = () => {
  const canWrite = useCanWritePlaylists();
  const { data, isLoading } = useListPlaylistQuery({});
  const [deletePlaylist] = useDeletePlaylistMutation();
  // Set after a repository-managed playlist is committed to a new branch; surfaces the PR banner.
  const { newPrURL, repoURL } = usePullRequestParam();
  const [urlParams] = useUrlParams();
  const branchInfo = {
    targetBranch: urlParams.get('ref') || undefined,
    configuredBranch: urlParams.get('repo_branch') || undefined,
    repoBaseUrl: repoURL,
  };
  const [searchQuery, setSearchQuery] = useState('');
  const allPlaylists = useMemo(() => data?.items ?? [], [data?.items]);
  const playlists = useMemo(() => searchPlaylists(allPlaylists, searchQuery), [searchQuery, allPlaylists]);

  // The client follows the apiserver's continue tokens, so a token left on the response it hands
  // back means the namespace holds more playlists than could be read. Search runs over what was
  // loaded, so those playlists are missing from the results too — which is exactly what makes
  // hiding this dangerous: an incomplete list is indistinguishable from a complete one.
  const isTruncated = Boolean(data?.metadata?.continue);

  const [startPlaylist, setStartPlaylist] = useState<Playlist | undefined>();
  const [playlistToDelete, setPlaylistToDelete] = useState<Playlist | undefined>();

  // Focus restoration for the delete-confirmation dialog. The dialog's own focus manager returns
  // focus only while the control that opened it is still connected, and confirming a deletion
  // unmounts that control together with its card as soon as the invalidated list query refetches,
  // which stranded focus on <body> (WCAG 2.4.3). These refs hold the control that opened the
  // dialog plus the two page-level links that survive a deletion, so focus can be relocated to
  // the opener when it survives and to the page's primary action when it does not.
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const focusRestorationPendingRef = useRef(false);
  const deleteConfirmedRef = useRef(false);
  const newPlaylistButtonRef = useRef<HTMLAnchorElement>(null);
  const createPlaylistButtonRef = useRef<HTMLAnchorElement>(null);

  const requestPlaylistDeletion = useCallback((playlist: Playlist) => {
    const trigger = document.activeElement;
    deleteTriggerRef.current = trigger instanceof HTMLElement ? trigger : null;
    focusRestorationPendingRef.current = true;
    deleteConfirmedRef.current = false;
    setPlaylistToDelete(playlist);
  }, []);

  const hasPlaylists = playlists && playlists.length > 0;
  const onDismissDelete = () => setPlaylistToDelete(undefined);
  const onDeletePlaylist = () => {
    if (!playlistToDelete) {
      return;
    }
    // The card can outlive the dialog by a render or two, so the restoration request stays open
    // until the refetch has told us whether the control that opened the dialog survived.
    deleteConfirmedRef.current = true;
    deletePlaylist({
      name: playlistToDelete.metadata?.name ?? '',
    }).finally(() => {
      setPlaylistToDelete(undefined);
    });
  };

  const showSearch = isLoading || playlists.length > 0 || searchQuery.length > 0;

  // Deliberately without a dependency array: the card holding the control that opened the dialog
  // can unmount one or more renders after the dialog itself closed, when the invalidated list
  // query refetches, and focus has to be relocated on that later render too. The effect only
  // reads refs and moves focus — it never sets state, so it cannot re-render itself.
  useEffect(() => {
    if (!focusRestorationPendingRef.current || playlistToDelete) {
      return;
    }

    const trigger = deleteTriggerRef.current;
    const active = document.activeElement;
    // Focus counts as orphaned when nothing meaningful holds it, which is what the browser falls
    // back to once the element that had focus is removed from the document.
    const focusIsOrphaned = active === null || active === document.body || active === document.documentElement;

    const endRestoration = () => {
      focusRestorationPendingRef.current = false;
      deleteTriggerRef.current = null;
      deleteConfirmedRef.current = false;
    };

    if (trigger?.isConnected) {
      if (focusIsOrphaned) {
        trigger.focus();
      } else if (active !== trigger) {
        // The user moved focus somewhere real of their own accord — never take it back from them.
        endRestoration();
        return;
      }
      if (!deleteConfirmedRef.current) {
        // Nothing was deleted, so the opener cannot disappear later: the request is finished.
        endRestoration();
      }
      return;
    }

    endRestoration();
    if (!focusIsOrphaned) {
      return;
    }
    // The opener went away with its card, so fall back to the page's own primary action. Exactly
    // one of these two links is rendered whenever a deletion was possible: the header action
    // while the list is searchable, and the empty-state link once the last playlist is gone.
    const fallbackTarget = newPlaylistButtonRef.current ?? createPlaylistButtonRef.current;
    fallbackTarget?.focus();
  });

  return (
    <Page
      actions={
        canWrite && showSearch ? (
          <LinkButton href="/playlists/new" ref={newPlaylistButtonRef}>
            <Trans i18nKey="playlist-page.create-button.title">New playlist</Trans>
          </LinkButton>
        ) : undefined
      }
      navId="dashboards/playlists"
    >
      <Page.Contents>
        {newPrURL && <PreviewBannerViewPR prURL={newPrURL} isNewPr repoUrl={repoURL} branchInfo={branchInfo} />}

        {showSearch && <PageActionBar searchQuery={searchQuery} setSearchQuery={setSearchQuery} />}

        {isTruncated && (
          <Alert severity="warning" title={t('playlist-page.truncated.title', 'Not all playlists are shown')}>
            {t('playlist-page.truncated.message', '', {
              count: allPlaylists.length,
              defaultValue_one:
                'This list is too large to load completely, so it shows {{count}} playlist. Playlists it leaves out are missing from the search results as well.',
              defaultValue_other:
                'This list is too large to load completely, so it shows the first {{count}} playlists. Playlists it leaves out are missing from the search results as well.',
            })}
          </Alert>
        )}

        {isLoading ? (
          <PlaylistPageList.Skeleton />
        ) : (
          <>
            {!hasPlaylists && searchQuery ? (
              <EmptyState variant="not-found" message={t('playlists.empty-state.message', 'No playlists found')} />
            ) : (
              <PlaylistPageList
                playlists={playlists}
                setStartPlaylist={setStartPlaylist}
                setPlaylistToDelete={requestPlaylistDeletion}
              />
            )}
            {!showSearch && (
              <EmptyState
                variant="call-to-action"
                button={
                  <LinkButton
                    disabled={!canWrite}
                    href="playlists/new"
                    icon="plus"
                    size="lg"
                    ref={createPlaylistButtonRef}
                  >
                    <Trans i18nKey="playlist-page.empty.button">Create playlist</Trans>
                  </LinkButton>
                }
                message={t('playlist-page.empty.title', 'There are no playlists created yet')}
              >
                <Trans i18nKey="playlist-page.empty.pro-tip">
                  You can use playlists to cycle dashboards on TVs without user control.{' '}
                  <TextLink external href="https://docs.grafana.org/reference/playlist/">
                    Learn more
                  </TextLink>
                </Trans>
              </EmptyState>
            )}
            {playlistToDelete &&
              (isManagedByRepository(playlistToDelete) ? (
                // Repository-managed playlists are removed by committing the deletion to git.
                <SaveProvisionedResourceDrawer
                  resource={playlistToDelete}
                  title={playlistToDelete.spec?.title ?? ''}
                  action="delete"
                  onDismiss={onDismissDelete}
                />
              ) : (
                <ConfirmModal
                  title={playlistToDelete.spec?.title ?? ''}
                  confirmText={t('playlist-page.delete-modal.confirm-text', 'Delete')}
                  body={t('playlist-page.delete-modal.body', 'Are you sure you want to delete {{name}} playlist?', {
                    name: playlistToDelete.spec?.title,
                  })}
                  onConfirm={onDeletePlaylist}
                  isOpen={Boolean(playlistToDelete)}
                  onDismiss={onDismissDelete}
                />
              ))}
            {startPlaylist && <StartModal playlist={startPlaylist} onDismiss={() => setStartPlaylist(undefined)} />}
          </>
        )}
      </Page.Contents>
    </Page>
  );
};

export default PlaylistPage;
