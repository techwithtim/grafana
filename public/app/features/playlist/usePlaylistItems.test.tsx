import { act, renderHook, waitFor } from '@testing-library/react';

import { type DashboardPickerDTO } from 'app/core/components/Select/DashboardPicker';

import { type DashboardQueryResult } from '../search/service/types';

import { type PlaylistItemUI } from './types';
import { usePlaylistItems } from './usePlaylistItems';
import * as playlistUtils from './utils';

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
});
