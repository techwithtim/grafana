import { lastValueFrom } from 'rxjs';

import { normalizeError } from '@grafana/api-clients';
import {
  BASE_URL,
  generatedAPI,
  type ListPlaylistApiArg,
  type Playlist,
  type PlaylistList,
  type PlaylistSpec,
} from '@grafana/api-clients/rtkq/playlist/v1';
import { isObject } from '@grafana/data';
import { t } from '@grafana/i18n';
import { type FetchResponse, getBackendSrv, isFetchError } from '@grafana/runtime';

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

/**
 * Maximum number of requests one unbounded playlist list query is allowed to make.
 *
 * The apiserver returns a list in chunks once the response outgrows its size budget (2 MiB in
 * unified storage) and hands back a `metadata.continue` token for the remainder, so reading a
 * whole namespace can take several requests. The cap is what keeps that walk finite: a server
 * that keeps answering with a token would otherwise make this query request and accumulate
 * without limit. When the walk stops at the cap the merged result keeps its continue token,
 * which is how the list page knows that what it holds is incomplete and says so.
 */
export const PLAYLIST_LIST_MAX_PAGES = 20;

/**
 * Reads the remaining chunks of a list response and merges them into the first one.
 *
 * The pages come out of the RTK Query cache, so nothing is mutated: the result is a new object
 * with a new items array. Its `metadata.continue` is empty once the namespace has been read to
 * the end, and still carries the outstanding token when the walk stopped at the page cap or a
 * continuation request failed — a failed continuation degrades to "these loaded, and they are
 * not all of them" rather than failing the whole query and showing nothing.
 */
async function listAllPlaylists(first: PlaylistList, arg: ListPlaylistApiArg): Promise<PlaylistList> {
  // Annotated, not inferred: the token is both sent with a request and read back from its
  // response, and without a declared type that round trip is a circular inference.
  let token: string | undefined = first.metadata?.continue;
  if (!token) {
    // One chunk held the whole namespace, which is the ordinary case.
    return first;
  }

  let items = [...(first.items ?? [])];
  const requested = new Set<string>();

  for (let page = 1; page < PLAYLIST_LIST_MAX_PAGES && token && !requested.has(token); page++) {
    requested.add(token);
    try {
      const response: FetchResponse<PlaylistList> = await lastValueFrom(
        getBackendSrv().fetch<PlaylistList>({
          method: 'GET',
          url: `${BASE_URL}/playlists`,
          // A continued list repeats the parameters that decide which playlists it contains and
          // carries no resourceVersion: the token already pins the snapshot it continues.
          params: { fieldSelector: arg.fieldSelector, labelSelector: arg.labelSelector, continue: token },
          showErrorAlert: false,
        })
      );
      items = items.concat(response.data.items ?? []);
      token = response.data.metadata?.continue;
    } catch {
      // Stop, keeping the token so the truncation is reported rather than hidden.
      break;
    }
  }

  return { ...first, items, metadata: { ...first.metadata, continue: token ?? '' } };
}

export const playlistAPIv1 = generatedAPI.enhanceEndpoints({
  endpoints: {
    listPlaylist: {
      transformResponse: async (response: PlaylistList, _meta: unknown, arg: ListPlaylistApiArg) => {
        // A caller that asked for a single page — with a limit, a continue token, a pinned
        // resourceVersion or a watch — gets exactly the page it asked for. Only the unbounded
        // list, which is what every playlist surface issues, is walked to the end here.
        if (arg.limit != null || arg.continue || arg.resourceVersion || arg.watch) {
          return response;
        }
        return listAllPlaylists(response, arg);
      },
    },
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
