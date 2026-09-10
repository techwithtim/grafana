import { act, renderHook, waitFor } from '@testing-library/react';

import { type DashboardPickerDTO } from 'app/core/components/Select/DashboardPicker';

import { type DashboardQueryResult, type QueryResponse, type SearchQuery } from '../search/service/types';

import { type PlaylistItemUI } from './types';
import { usePlaylistItems } from './usePlaylistItems';
import * as playlistUtils from './utils';

/**
 * The searcher every dashboard search in this file ends at. The cases that gate `loadDashboards`
 * never reach it; the cases that count requests run the real loader against it, because the number
 * of searches a change of the item list starts is the thing they are about.
 */
const mockSearch = jest.fn<Promise<QueryResponse>, [SearchQuery]>();

jest.mock('app/features/search/service/searcher', () => ({
  getGrafanaSearcher: () => ({ search: mockSearch }),
}));

/** One gated `loadDashboards` call: the item list it was given, and the resolver that completes it. */
interface GatedLoad {
  items: PlaylistItemUI[];
  resolve: (loaded: PlaylistItemUI[]) => void;
}

/**
 * Replaces `loadDashboards` with a loader whose every call stays in flight until the test resolves
 * it by hand. A timed delay would leave the order in which a search result and a later edit land to
 * the wall clock; a deferred per call makes that order exact, which is what these cases are about.
 */
function gateLoadDashboards() {
  const calls: GatedLoad[] = [];
  const loadDashboards = jest.spyOn(playlistUtils, 'loadDashboards').mockImplementation(
    (items) =>
      new Promise<PlaylistItemUI[]>((resolve) => {
        calls.push({ items, resolve });
      })
  );

  return { calls, loadDashboards };
}

/**
 * A search response holding `hits`. `loadDashboards` reads a response through `view.map` alone, so
 * the remaining members are what a caller of this stub never reaches.
 */
function searchResponse(hits: DashboardQueryResult[]): QueryResponse {
  return {
    view: { map: (fn: (hit: DashboardQueryResult, index: number) => unknown) => hits.map(fn) },
    loadMoreItems: async () => {},
    isItemLoaded: () => true,
    totalRows: hits.length,
  } as unknown as QueryResponse;
}

/** The queries the stubbed searcher was asked for, in the order it was asked. */
function searchedQueries(): SearchQuery[] {
  return mockSearch.mock.calls.map(([query]) => query);
}

/** A search hit in the shape `loadDashboards` attaches to an item it resolved. */
function dashboardHit(uid: string, name: string): DashboardQueryResult {
  return {
    kind: 'dashboard',
    name,
    uid,
    url: `/d/${uid}/${uid.replace(/_/g, '-')}`,
    panel_type: '',
    tags: [],
    location: 'general',
    ds_uid: [],
    score: 0,
    explain: {},
  };
}

describe('usePlaylistItems', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('updateItemVariables', () => {
    // Both items already carry a `dashboards` property, so the enrichment effect has nothing to
    // load and cannot itself replace the item list. Any change of array identity in these cases is
    // therefore `updateItemVariables`, which is what they are observing.
    function loadedItems(): PlaylistItemUI[] {
      return [
        { type: 'dashboard_by_uid', value: 'uid_1', dashboards: [] },
        { type: 'dashboard_by_tag', value: 'tag_A', dashboards: [] },
      ];
    }

    it('sets the variables of an item the list holds', async () => {
      const { loadDashboards } = gateLoadDashboards();
      const initialItems = loadedItems();
      const { result } = renderHook(() => usePlaylistItems(initialItems));

      await act(async () => {
        result.current.updateItemVariables(0, { host: ['a'] });
      });

      expect(result.current.items).toEqual([
        { type: 'dashboard_by_uid', value: 'uid_1', dashboards: [], variables: { host: ['a'] } },
        { type: 'dashboard_by_tag', value: 'tag_A', dashboards: [] },
      ]);
      expect(loadDashboards).not.toHaveBeenCalled();
    });

    it('ignores an index beyond the end of the item list', async () => {
      const { loadDashboards } = gateLoadDashboards();
      const initialItems = loadedItems();
      const { result } = renderHook(() => usePlaylistItems(initialItems));
      const before = result.current.items;

      await act(async () => {
        result.current.updateItemVariables(5, { host: ['a'] });
      });

      expect(result.current.items).toBe(before);
      expect(result.current.items).toEqual(loadedItems());
      expect(loadDashboards).not.toHaveBeenCalled();
    });

    it('ignores a negative index', async () => {
      const { loadDashboards } = gateLoadDashboards();
      const initialItems = loadedItems();
      const { result } = renderHook(() => usePlaylistItems(initialItems));
      const before = result.current.items;

      await act(async () => {
        result.current.updateItemVariables(-1, { host: ['a'] });
      });

      expect(result.current.items).toBe(before);
      expect(result.current.items).toEqual(loadedItems());
      expect(loadDashboards).not.toHaveBeenCalled();
    });
  });

  describe('dashboard enrichment', () => {
    const secondDashboard: DashboardPickerDTO = {
      uid: 'uid_2',
      name: 'Second dashboard',
      folderUid: 'folder_1',
      folderTitle: 'Folder 1',
    };

    function unloadedItem(): PlaylistItemUI[] {
      return [{ type: 'dashboard_by_uid', value: 'uid_1' }];
    }

    it('attaches the loaded dashboards to the item that matches and starts no further load', async () => {
      const { calls, loadDashboards } = gateLoadDashboards();
      const initialItems = unloadedItem();
      const { result } = renderHook(() => usePlaylistItems(initialItems));

      await waitFor(() => {
        expect(loadDashboards).toHaveBeenCalledTimes(1);
      });
      expect(calls[0].items).toEqual([{ type: 'dashboard_by_uid', value: 'uid_1' }]);

      const loaded = [dashboardHit('uid_1', 'First dashboard')];
      await act(async () => {
        calls[0].resolve([{ type: 'dashboard_by_uid', value: 'uid_1', dashboards: loaded }]);
      });

      expect(result.current.items).toEqual([{ type: 'dashboard_by_uid', value: 'uid_1', dashboards: loaded }]);
      // The merged item now carries dashboards, so the effect the merge re-ran has nothing to load.
      expect(loadDashboards).toHaveBeenCalledTimes(1);
    });

    it('loads only the items that carry no dashboards', async () => {
      const { calls, loadDashboards } = gateLoadDashboards();
      const initialItems: PlaylistItemUI[] = [
        { type: 'dashboard_by_uid', value: 'uid_1', dashboards: [dashboardHit('uid_1', 'First dashboard')] },
        { type: 'dashboard_by_tag', value: 'tag_A' },
      ];
      const { result } = renderHook(() => usePlaylistItems(initialItems));

      await waitFor(() => {
        expect(loadDashboards).toHaveBeenCalledTimes(1);
      });
      // The resolved item is not part of the load: an item's dashboards are already there, so
      // asking for them again is a request that can only return what the item holds.
      expect(calls[0].items).toEqual([{ type: 'dashboard_by_tag', value: 'tag_A' }]);

      const before = result.current.items;
      const loaded = [dashboardHit('uid_2', 'Tagged dashboard')];
      await act(async () => {
        calls[0].resolve([{ type: 'dashboard_by_tag', value: 'tag_A', dashboards: loaded }]);
      });

      expect(result.current.items[1]).toEqual({ type: 'dashboard_by_tag', value: 'tag_A', dashboards: loaded });
      // The item the load left out keeps the object it had, not a copy of it.
      expect(result.current.items[0]).toBe(before[0]);
      expect(loadDashboards).toHaveBeenCalledTimes(1);
    });

    it('attaches one loaded result to every item that shares its type and value', async () => {
      const { calls, loadDashboards } = gateLoadDashboards();
      // The same dashboard listed twice, each row with its own variables: one search answers both,
      // and the result has to reach both rows without touching what makes them different.
      const initialItems: PlaylistItemUI[] = [
        { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['a'] } },
        { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['b'] } },
      ];
      const { result } = renderHook(() => usePlaylistItems(initialItems));

      await waitFor(() => {
        expect(loadDashboards).toHaveBeenCalledTimes(1);
      });

      const loaded = [dashboardHit('uid_1', 'First dashboard')];
      await act(async () => {
        calls[0].resolve([{ type: 'dashboard_by_uid', value: 'uid_1', dashboards: loaded }]);
      });

      expect(result.current.items).toEqual([
        { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['a'] }, dashboards: loaded },
        { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['b'] }, dashboards: loaded },
      ]);
      expect(loadDashboards).toHaveBeenCalledTimes(1);
    });

    it('leaves the item list untouched when a load resolves after the items it described are gone', async () => {
      const { calls, loadDashboards } = gateLoadDashboards();
      const initialItems = unloadedItem();
      const { result } = renderHook(() => usePlaylistItems(initialItems));

      await waitFor(() => {
        expect(loadDashboards).toHaveBeenCalledTimes(1);
      });

      // Swap the item out while the first load is still gated, so that load's result describes an
      // item the list no longer holds. Replacing it re-runs the effect, giving a second gated load.
      await act(async () => {
        result.current.deleteItem(0);
      });
      await act(async () => {
        result.current.addByUID(secondDashboard);
      });
      await waitFor(() => {
        expect(loadDashboards).toHaveBeenCalledTimes(2);
      });

      const before = result.current.items;
      await act(async () => {
        calls[0].resolve([
          { type: 'dashboard_by_uid', value: 'uid_1', dashboards: [dashboardHit('uid_1', 'First dashboard')] },
        ]);
      });

      // A merge that matched nothing must hand back the array it was given rather than a copy: the
      // enrichment effect depends on `items`, so a fresh reference would re-render and start a
      // third load, which would in turn produce a fourth. Array identity and the call count staying
      // at two are that contract, and the stale result must not reach the surviving item either.
      expect(result.current.items).toBe(before);
      expect(result.current.items).toEqual([{ type: 'dashboard_by_uid', value: 'uid_2' }]);
      expect(result.current.items[0].dashboards).toBeUndefined();
      expect(loadDashboards).toHaveBeenCalledTimes(2);

      // The still-gated second load describes the item that is there, and merges normally.
      const loaded = [dashboardHit('uid_2', 'Second dashboard')];
      await act(async () => {
        calls[1].resolve([{ type: 'dashboard_by_uid', value: 'uid_2', dashboards: loaded }]);
      });

      expect(result.current.items).toEqual([{ type: 'dashboard_by_uid', value: 'uid_2', dashboards: loaded }]);
      expect(loadDashboards).toHaveBeenCalledTimes(2);
    });

    it('keeps variables entered while the load was in flight and still attaches the dashboards', async () => {
      const { calls, loadDashboards } = gateLoadDashboards();
      const initialItems = unloadedItem();
      const { result } = renderHook(() => usePlaylistItems(initialItems));

      await waitFor(() => {
        expect(loadDashboards).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        result.current.updateItemVariables(0, { host: ['a', 'b'] });
      });

      const loaded = [dashboardHit('uid_1', 'First dashboard')];
      await act(async () => {
        calls[0].resolve([{ type: 'dashboard_by_uid', value: 'uid_1', dashboards: loaded }]);
      });

      expect(result.current.items).toEqual([
        { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['a', 'b'] }, dashboards: loaded },
      ]);

      // The variable edit changed the item list while it still had no dashboards, so the effect
      // re-ran and a second load is in flight. Its result carries no variables, so resolving it
      // proves the merge takes only `dashboards` from the loader.
      expect(loadDashboards).toHaveBeenCalledTimes(2);
      await act(async () => {
        calls[1].resolve([{ type: 'dashboard_by_uid', value: 'uid_1', dashboards: loaded }]);
      });

      expect(result.current.items).toEqual([
        { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['a', 'b'] }, dashboards: loaded },
      ]);
    });
  });

  /**
   * These cases run the real `loadDashboards` against the stubbed searcher and count the searches
   * it starts, which is the only place the cost of enrichment is visible: a hook test that stubs the
   * loader cannot see that one added dashboard used to re-query every row already on screen.
   */
  describe('search requests', () => {
    const thirdDashboard: DashboardPickerDTO = {
      uid: 'uid_c',
      name: 'Third dashboard',
      folderUid: 'folder_1',
      folderTitle: 'Folder 1',
    };

    /** The editor state the finding describes: the same dashboard three times, a second one, a tag. */
    function duplicateHeavyItems(): PlaylistItemUI[] {
      return [
        { type: 'dashboard_by_uid', value: 'uid_a', variables: { host: ['h1'] } },
        { type: 'dashboard_by_uid', value: 'uid_a', variables: { host: ['h2'] } },
        { type: 'dashboard_by_uid', value: 'uid_a' },
        { type: 'dashboard_by_uid', value: 'uid_b' },
        { type: 'dashboard_by_tag', value: 'tag_x' },
      ];
    }

    /** The query `loadDashboards` builds for an item, with its selector filled in by the caller. */
    function searchFor(selector: Pick<SearchQuery, 'uid'> | Pick<SearchQuery, 'tags'>): SearchQuery {
      return { query: '*', kind: ['dashboard'], limit: 1000, ...selector };
    }

    beforeEach(() => {
      mockSearch.mockReset();
      mockSearch.mockImplementation(async (query: SearchQuery) => {
        const uid = query.uid?.[0];
        if (uid) {
          return searchResponse([dashboardHit(uid, `Dashboard ${uid}`)]);
        }
        const tag = query.tags?.[0] ?? '';
        return searchResponse([dashboardHit(`${tag}_1`, `First ${tag}`), dashboardHit(`${tag}_2`, `Second ${tag}`)]);
      });
    });

    it('searches once per distinct type and value, and once more for the item an add leaves unresolved', async () => {
      const { result } = renderHook(() => usePlaylistItems(duplicateHeavyItems()));

      await waitFor(() => {
        expect(result.current.items.every((item) => item.dashboards)).toBe(true);
      });

      // Five rows, three distinct dashboards to look up.
      expect(mockSearch).toHaveBeenCalledTimes(3);
      expect(searchedQueries()).toEqual([
        searchFor({ uid: ['uid_a'] }),
        searchFor({ uid: ['uid_b'] }),
        searchFor({ tags: ['tag_x'] }),
      ]);

      const dashboardA = [dashboardHit('uid_a', 'Dashboard uid_a')];
      const taggedDashboards = [dashboardHit('tag_x_1', 'First tag_x'), dashboardHit('tag_x_2', 'Second tag_x')];
      expect(result.current.items).toEqual([
        { type: 'dashboard_by_uid', value: 'uid_a', variables: { host: ['h1'] }, dashboards: dashboardA },
        { type: 'dashboard_by_uid', value: 'uid_a', variables: { host: ['h2'] }, dashboards: dashboardA },
        { type: 'dashboard_by_uid', value: 'uid_a', dashboards: dashboardA },
        { type: 'dashboard_by_uid', value: 'uid_b', dashboards: [dashboardHit('uid_b', 'Dashboard uid_b')] },
        { type: 'dashboard_by_tag', value: 'tag_x', dashboards: taggedDashboards },
      ]);

      await act(async () => {
        result.current.addByUID(thirdDashboard);
      });
      await waitFor(() => {
        expect(result.current.items[5]?.dashboards).toEqual([dashboardHit('uid_c', 'Dashboard uid_c')]);
      });

      // The added row is the only one that had nothing to show, so it is the only one searched for.
      expect(mockSearch).toHaveBeenCalledTimes(4);
      expect(searchedQueries()[3]).toEqual(searchFor({ uid: ['uid_c'] }));
    });

    it('searches once more for a tag an add appends, leaving the resolved rows alone', async () => {
      const { result } = renderHook(() => usePlaylistItems(duplicateHeavyItems()));

      await waitFor(() => {
        expect(result.current.items.every((item) => item.dashboards)).toBe(true);
      });
      expect(mockSearch).toHaveBeenCalledTimes(3);

      await act(async () => {
        result.current.addByTag(['tag_y']);
      });
      await waitFor(() => {
        expect(result.current.items[5]?.dashboards).toEqual([
          dashboardHit('tag_y_1', 'First tag_y'),
          dashboardHit('tag_y_2', 'Second tag_y'),
        ]);
      });

      expect(mockSearch).toHaveBeenCalledTimes(4);
      expect(searchedQueries()[3]).toEqual(searchFor({ tags: ['tag_y'] }));
    });

    it('starts no search at all when a reorder or a deletion changes the list', async () => {
      const { result } = renderHook(() => usePlaylistItems(duplicateHeavyItems()));

      await waitFor(() => {
        expect(result.current.items.every((item) => item.dashboards)).toBe(true);
      });
      expect(mockSearch).toHaveBeenCalledTimes(3);

      await act(async () => {
        result.current.moveItem(0, 3);
      });
      await act(async () => {
        result.current.deleteItem(1);
      });

      // Both changes only rearrange items that already carry their dashboards.
      expect(result.current.items.map((item) => item.value)).toEqual(['uid_a', 'uid_b', 'uid_a', 'tag_x']);
      expect(result.current.items.every((item) => item.dashboards)).toBe(true);
      expect(mockSearch).toHaveBeenCalledTimes(3);
    });

    it('treats an item whose search found nothing as resolved and never searches for it again', async () => {
      mockSearch.mockImplementation(async () => searchResponse([]));
      const { result } = renderHook(() => usePlaylistItems([{ type: 'dashboard_by_uid', value: 'uid_a' }]));

      await waitFor(() => {
        expect(result.current.items[0].dashboards).toEqual([]);
      });
      expect(mockSearch).toHaveBeenCalledTimes(1);

      // An empty result is an answer. Were it read as "not loaded yet", every render that follows
      // would start the same search again.
      await act(async () => {
        result.current.updateItemVariables(0, { host: ['a'] });
      });

      expect(result.current.items).toEqual([
        { type: 'dashboard_by_uid', value: 'uid_a', variables: { host: ['a'] }, dashboards: [] },
      ]);
      expect(mockSearch).toHaveBeenCalledTimes(1);
    });
  });
});
