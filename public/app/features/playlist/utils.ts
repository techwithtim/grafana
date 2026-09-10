import { t } from '@grafana/i18n';
import { useFlagPlaylistsRBAC } from '@grafana/runtime/internal';
import { AccessControlAction } from 'app/types/accessControl';

import { type Playlist } from '../../api/clients/playlist/v1';
import { contextSrv } from '../../core/services/context_srv';
import { getGrafanaSearcher } from '../search/service/searcher';
import { type SearchQuery } from '../search/service/types';

import { type PlaylistItemUI } from './types';

export function useCanWritePlaylists(): boolean {
  const enabled = useFlagPlaylistsRBAC();
  return enabled ? contextSrv.hasPermission(AccessControlAction.PlaylistsWrite) : contextSrv.isEditor;
}

/**
 * Returns a copy with the dashboards loaded
 *
 * An item's dashboards follow from its type and value alone, so items that share that pair are
 * answered by a single search: a playlist legitimately lists the same dashboard more than once —
 * once per set of variable values — and the editor holds each of those as its own row, so querying
 * per row multiplied one list into a burst of identical requests. The returned list still holds one
 * copy of every item, at its own position, carrying every property it came with, which is what the
 * callers that pair the result with their own item list rely on.
 */
export async function loadDashboards(items: PlaylistItemUI[]): Promise<PlaylistItemUI[]> {
  if (!items?.length) {
    return [];
  }

  const targets: SearchQuery[] = [];
  // Which of those searches answers each item, and which pair each search was built from. `type` is
  // one of a fixed set of names that hold no NUL character, so a joined key belongs to exactly one
  // pair whatever an item's stored value contains.
  const targetOfItem: number[] = [];
  const targetOfPair = new Map<string, number>();

  for (const item of items) {
    const pair = `${item.type}\u0000${item.value}`;
    const existing = targetOfPair.get(pair);
    if (existing !== undefined) {
      targetOfItem.push(existing);
      continue;
    }

    const query: SearchQuery = {
      query: '*',
      kind: ['dashboard'],
      limit: 1000,
    };

    switch (item.type) {
      case 'dashboard_by_id':
        throw new Error('invalid item (with id)');

      case 'dashboard_by_uid':
        query.uid = [item.value];
        break;

      case 'dashboard_by_tag':
        query.tags = [item.value];
        break;
    }

    const target = targets.push(query) - 1;
    targetOfPair.set(pair, target);
    targetOfItem.push(target);
  }

  const searcher = getGrafanaSearcher();
  const results = await Promise.allSettled(targets.map((target) => searcher.search(target)));

  // A result view is a window onto a data frame that reuses the object it yields, so each row is
  // copied out of it once, here. A search that failed leaves the items it answers with no
  // dashboards rather than failing the whole load.
  const dashboardsOfTarget = results.map((result) =>
    result.status === 'fulfilled' ? result.value.view.map((v) => ({ ...v })) : []
  );

  // Items answered by the same search are handed the same list. Its contents are read, never
  // written — the editor renders them and playback reads each dashboard's URL — and the merge in
  // `usePlaylistItems` already gives duplicate rows one list between them.
  return items.map((item, i) => ({ ...item, dashboards: dashboardsOfTarget[targetOfItem[i]] }));
}

export function getDefaultPlaylist(): Playlist {
  return {
    apiVersion: 'playlist.grafana.app/v1',
    kind: 'Playlist',
    spec: {
      items: [],
      interval: '5m',
      title: '',
    },
    metadata: {
      name: '',
    },
    status: {},
  };
}

/**
 * How a playlist is named wherever its title is shown to a person: its own title, or a fallback
 * naming it by resource name when the title is blank.
 *
 * The editor now refuses a name that is blank once trimmed, but a playlist stored before it did —
 * or written straight through the API, where the app validator deliberately checks neither title
 * nor interval — still has one, and a card and a delete confirmation with nothing in them identify
 * no playlist at all.
 *
 * Escaping is turned off for this one interpolation because the resource name is stored text that
 * React renders as a text node, never as HTML: with i18next's default escaping a name containing
 * `&` or a quote would be shown as its HTML entity.
 */
export function playlistLabel(playlist: Playlist): string {
  const title = playlist.spec?.title?.trim();
  if (title) {
    return title;
  }

  const name = playlist.metadata?.name;
  return name
    ? t('playlist-page.untitled-playlist-named', 'Untitled playlist ({{name}})', {
        name,
        interpolation: { escapeValue: false },
      })
    : t('playlist-page.untitled-playlist', 'Untitled playlist');
}

export function searchPlaylists(playlists: Playlist[], query?: string): Playlist[] {
  if (!query?.length) {
    return playlists;
  }
  query = query.toLowerCase();
  return playlists.filter((v) => v.spec?.title.toLowerCase().includes(query!));
}
