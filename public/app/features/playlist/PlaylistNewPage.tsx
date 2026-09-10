import { useState } from 'react';

import { type NavModelItem } from '@grafana/data';
import { t } from '@grafana/i18n';
import { locationService } from '@grafana/runtime';
import { Page } from 'app/core/components/Page/Page';

import { type Playlist, useCreatePlaylistMutation } from '../../api/clients/playlist/v1';
import { SaveProvisionedResourceDrawer } from '../provisioning/components/Shared/SaveProvisionedResourceDrawer';
import { useResourceRepositorySelection } from '../provisioning/hooks/useResourceRepositorySelection';
import { resourceKindInfos } from '../provisioning/utils/resourceKinds';

import { PlaylistForm } from './PlaylistForm';
import { getDefaultPlaylist } from './utils';

export const PlaylistNewPage = () => {
  const [playlist] = useState<Playlist>(getDefaultPlaylist());
  const [createPlaylist] = useCreatePlaylistMutation();
  const { isAvailable, repositories } = useResourceRepositorySelection(resourceKindInfos.playlist);
  // No selection = save to Grafana; a repository name routes the save through the provisioning drawer.
  const [selectedRepository, setSelectedRepository] = useState<string | undefined>(undefined);
  // Holds the playlist while the provisioning save drawer is open.
  const [provisionedPlaylist, setProvisionedPlaylist] = useState<Playlist | undefined>();

  const onSubmit = async (playlist: Playlist) => {
    if (selectedRepository) {
      setProvisionedPlaylist(playlist);
      return;
    }

    try {
      // `unwrap()` is what makes a failed create observable here: an RTK Query mutation trigger
      // resolves with `{ error }` instead of rejecting, so awaiting the trigger alone would fall
      // through to the navigation below and unmount the form — discarding everything the user
      // typed, including the variables committed on each row.
      await createPlaylist({ playlist }).unwrap();
    } catch {
      // The error notification is already raised by `createPlaylist`'s `onQueryStarted`, so the
      // only thing left to do is stay put: returning leaves the form mounted with the user's input
      // intact, and `PlaylistForm.doSubmit` re-enables Save in its `finally`, making the retry one
      // click. The error is deliberately not re-thrown — `doSubmit` awaits this inside
      // react-hook-form's submit handler, where a rejection becomes an unhandled rejection.
      return;
    }

    // Reached only once the playlist is stored. `createPlaylist` invalidates the `Playlist` tag, so
    // awaiting it also means the list query is invalidated before `/playlists` mounts and the list
    // shows what was just created without a manual reload.
    locationService.push('/playlists');
  };

  const pageNav: NavModelItem = {
    text: t('playlist.playlist-new-page.page-nav.text.new-playlist', 'New playlist'),
    subTitle:
      'A playlist rotates through a pre-selected list of dashboards. A playlist can be a great way to build situational awareness, or just show off your metrics to your team or visitors.',
  };

  return (
    <Page navId="dashboards/playlists" pageNav={pageNav}>
      <Page.Contents>
        <PlaylistForm
          onSubmit={onSubmit}
          playlist={playlist}
          showRepositorySelect={isAvailable}
          repositories={repositories}
          selectedRepository={selectedRepository}
          onRepositoryChange={setSelectedRepository}
        />
      </Page.Contents>
      {provisionedPlaylist && selectedRepository && (
        <SaveProvisionedResourceDrawer
          resource={provisionedPlaylist}
          title={provisionedPlaylist.spec?.title ?? ''}
          action="create"
          repositoryName={selectedRepository}
          onDismiss={() => setProvisionedPlaylist(undefined)}
        />
      )}
    </Page>
  );
};

export default PlaylistNewPage;
