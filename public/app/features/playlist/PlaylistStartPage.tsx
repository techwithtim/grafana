import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom-v5-compat';

import { Trans, t } from '@grafana/i18n';
import { Alert, LinkButton, LoadingPlaceholder, Stack } from '@grafana/ui';
import { Page } from 'app/core/components/Page/Page';

import { useGetPlaylistQuery } from '../../api/clients/playlist/v1';

import { type PlaylistStartFailureReason, playlistSrv } from './PlaylistSrv';

/**
 * Everything that can leave this page without a dashboard to redirect to: a playlist that would not
 * load at all, one of the two reasons a loaded playlist cannot be played, and a start that failed
 * outright (a dashboard search that could not be reached, for instance).
 */
type StartProblem = 'load-failed' | 'start-failed' | PlaylistStartFailureReason;

/**
 * What the viewer is told about `problem`, and what they can do about it.
 *
 * Each message names the cause rather than the symptom, because the symptom — a page with no
 * dashboard on it — is all the viewer can otherwise see.
 */
function getProblemMessage(problem: StartProblem): { title: string; body: string } {
  switch (problem) {
    case 'no-items':
      return {
        title: t('playlist.playlist-start-page.empty-title', 'This playlist is empty'),
        body: t(
          'playlist.playlist-start-page.empty-body',
          'The playlist has no dashboards to play. Edit the playlist to add dashboards to it.'
        ),
      };
    case 'no-dashboards':
      return {
        title: t('playlist.playlist-start-page.no-dashboards-title', 'No dashboards could be found for this playlist'),
        body: t(
          'playlist.playlist-start-page.no-dashboards-body',
          'None of the dashboards in this playlist could be found. They may have been deleted, or you may not have permission to view them. Edit the playlist to choose dashboards that exist.'
        ),
      };
    case 'load-failed':
      return {
        title: t('playlist.playlist-start-page.load-failed-title', 'This playlist could not be loaded'),
        body: t(
          'playlist.playlist-start-page.load-failed-body',
          'Grafana could not load this playlist. It may have been deleted, or you may not have permission to view it.'
        ),
      };
    case 'start-failed':
      return {
        title: t('playlist.playlist-start-page.start-failed-title', 'This playlist could not be started'),
        body: t(
          'playlist.playlist-start-page.start-failed-body',
          'Something went wrong while starting the playlist. Try again, or edit the playlist to check the dashboards it plays.'
        ),
      };
  }
}

/**
 * Starts a playlist and redirects to its first dashboard.
 *
 * The page has nothing of its own to show once playback begins, because starting a playlist
 * replaces this location with the first dashboard. Until then, and whenever a playlist cannot be
 * played at all, it is the only surface the viewer has: it reports that the playlist is starting,
 * and otherwise names why it did not start and offers the two ways out — the playlist's editor, and
 * the playlist list.
 */
export default function PlaylistStartPage() {
  const { uid = '' } = useParams();
  const { data, isLoading, isError } = useGetPlaylistQuery({ name: uid });
  const [startFailure, setStartFailure] = useState<StartProblem | undefined>();
  // Starting a playlist is a side effect on a singleton service, so it happens once per loaded
  // playlist rather than once per render of one.
  const startedRef = useRef(false);

  useEffect(() => {
    if (isLoading || !data || startedRef.current) {
      return;
    }

    startedRef.current = true;
    playlistSrv
      .start(data)
      .then((result) => {
        if (!result.started) {
          setStartFailure(result.failureReason);
        }
      })
      .catch(() => {
        setStartFailure('start-failed');
      });
  }, [data, isLoading]);

  const problem: StartProblem | undefined = isError ? 'load-failed' : startFailure;
  const message = problem ? getProblemMessage(problem) : undefined;

  return (
    <Page navId="dashboards/playlists" pageNav={{ text: t('playlist.playlist-start-page.title', 'Start playlist') }}>
      <Page.Contents isLoading={isLoading}>
        {message ? (
          <Alert severity="error" title={message.title}>
            <Stack direction="column" alignItems="flex-start" gap={2}>
              <span>{message.body}</span>
              <Stack direction="row" gap={1}>
                {/* A playlist that never loaded has no editor worth offering, so only the list is. */}
                {problem !== 'load-failed' && (
                  <LinkButton variant="secondary" href={`/playlists/edit/${uid}`}>
                    <Trans i18nKey="playlist.playlist-start-page.edit-playlist">Edit playlist</Trans>
                  </LinkButton>
                )}
                <LinkButton variant="secondary" href="/playlists">
                  <Trans i18nKey="playlist.playlist-start-page.back-to-playlists">Back to playlists</Trans>
                </LinkButton>
              </Stack>
            </Stack>
          </Alert>
        ) : (
          <LoadingPlaceholder text={t('playlist.playlist-start-page.starting', 'Starting playlist...')} />
        )}
      </Page.Contents>
    </Page>
  );
}
