import { normalizeError } from '@grafana/api-clients';
import { generatedAPI, type Playlist, type PlaylistSpec } from '@grafana/api-clients/rtkq/playlist/v1';
import { isObject } from '@grafana/data';
import { t } from '@grafana/i18n';
import { getBackendSrv, isFetchError } from '@grafana/runtime';

import { createErrorNotification, createSuccessNotification } from '../../../../core/copy/appNotification';
import { notifyApp } from '../../../../core/reducers/appNotification';
import { contextSrv } from '../../../../core/services/context_srv';
import { handleError } from '../../../utils';

/**
 * Finds the underlying request failure in the two shapes a playlist error arrives in.
 *
 * A query hook exposes the value the base query returned, which is Grafana's `FetchError`. A
 * mutation's `queryFulfilled` instead rejects with a `{ error, isUnhandledError, meta }` wrapper
 * built by RTK Query, so the same failure has to be unwrapped one level before it can be
 * recognised.
 */
function toFetchError(error: unknown) {
  if (isFetchError(error)) {
    return error;
  }
  if (isObject(error) && 'error' in error && isFetchError(error.error)) {
    return error.error;
  }
  return undefined;
}

/**
 * Turns a failed playlist request into a message written for the person reading it.
 *
 * A playlist request that fails reaches the UI as a Grafana `FetchError` whose `data` is the
 * apiserver's `Status` object. For a conflict or a missing playlist that object's `message` names
 * the internal resource — `playlists.playlist.grafana.app "<uid>"` — which tells a user nothing and
 * describes an identifier they never chose. Those outcomes are therefore mapped to text that says
 * what happened and what to do about it. Anything else falls back to the backend's own message,
 * which is already phrased for a human, and never to the serialized error object: that carries the
 * request URL, method and headers.
 */
export function getPlaylistErrorMessage(error: unknown): string {
  const fetchError = toFetchError(error);

  switch (fetchError?.status) {
    case 403:
      return t('playlist-edit.error-forbidden', 'You do not have permission to view or change this playlist.');
    case 404:
      return t('playlist-edit.error-not-found', 'This playlist no longer exists. It may have been deleted.');
    case 409:
      return t(
        'playlist-edit.error-conflict',
        'This playlist was changed somewhere else. Reload the page and apply your changes to the latest version.'
      );
    default:
      return normalizeError(error);
  }
}

export const playlistAPIv1 = generatedAPI.enhanceEndpoints({
  endpoints: {
    getPlaylist: {
      transformResponse: async (response: Playlist) => {
        await migrateInternalIDs(response.spec);
        return response;
      },
    },
    createPlaylist: (endpointDefinition) => {
      const originalQuery = endpointDefinition.query;
      if (!originalQuery) {
        return;
      }

      endpointDefinition.query = (requestOptions) => {
        const metadata = requestOptions.playlist.metadata;
        if (metadata && !metadata.name && !metadata.generateName) {
          // GenerateName lets the apiserver create a new uid for the name
          // The passed in value is the suggested prefix
          metadata.generateName = contextSrv.user.login?.slice(0, 2) || 'g';
        }
        return originalQuery(requestOptions);
      };

      endpointDefinition.onQueryStarted = async (_, { queryFulfilled, dispatch }) => {
        try {
          await queryFulfilled;
          dispatch(notifyApp(createSuccessNotification('Playlist created')));
        } catch (e) {
          handleError(e, dispatch, 'Unable to create playlist');
        }
      };
    },
    replacePlaylist: {
      onQueryStarted: async (_, { queryFulfilled, dispatch }) => {
        try {
          await queryFulfilled;
          dispatch(notifyApp(createSuccessNotification('Playlist updated')));
        } catch (e) {
          // Saving over a playlist someone else has already changed is the one failure a user hits
          // in normal use, and the apiserver reports it by naming its own resource. Map it (and the
          // other recognised reasons) rather than passing the raw message through `handleError`.
          dispatch(notifyApp(createErrorNotification('Unable to update playlist', getPlaylistErrorMessage(e))));
        }
      },
    },
    deletePlaylist: {
      onQueryStarted: async (_, { queryFulfilled, dispatch }) => {
        try {
          await queryFulfilled;
          dispatch(notifyApp(createSuccessNotification('Playlist deleted')));
        } catch (e) {
          handleError(e, dispatch, 'Unable to delete playlist');
        }
      },
    },
  },
});

/** @deprecated -- this migrates playlists saved with internal ids to uid  */
async function migrateInternalIDs(playlist?: PlaylistSpec) {
  if (playlist?.items) {
    for (const item of playlist.items) {
      if (item.type === 'dashboard_by_id') {
        item.type = 'dashboard_by_uid';
        const uids = await getBackendSrv().get<string[]>(`/api/dashboards/ids/${item.value}`);
        if (uids?.length) {
          item.value = uids[0];
        }
      }
    }
  }
}

export const {
  useCreatePlaylistMutation,
  useDeletePlaylistMutation,
  useGetPlaylistQuery,
  useListPlaylistQuery,
  useReplacePlaylistMutation,
} = playlistAPIv1;

// eslint-disable-next-line no-barrel-files/no-barrel-files
export type { Playlist, PlaylistSpec } from '@grafana/api-clients/rtkq/playlist/v1';
