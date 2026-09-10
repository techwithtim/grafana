import { act, getWrapper, renderHook } from 'test/test-utils';

import { setTestFlags } from '@grafana/test-utils/unstable';
import { contextSrv } from 'app/core/services/context_srv';
import { AccessControlAction } from 'app/types/accessControl';

import { type DashboardQueryResult, type QueryResponse, type SearchQuery } from '../search/service/types';

import { type PlaylistItemUI } from './types';
import { loadDashboards, useCanWritePlaylists } from './utils';

/** The searcher `loadDashboards` sends its queries to. */
const mockSearch = jest.fn<Promise<QueryResponse>, [SearchQuery]>();

jest.mock('app/features/search/service/searcher', () => ({
  getGrafanaSearcher: () => ({ search: mockSearch }),
}));

jest.mock('app/core/services/context_srv', () => ({
  ...jest.requireActual('app/core/services/context_srv'),
  contextSrv: {
    ...jest.requireActual('app/core/services/context_srv').contextSrv,
    hasPermission: jest.fn(),
    isEditor: false,
  },
}));

const renderUseCanWritePlaylists = () => renderHook(() => useCanWritePlaylists(), { wrapper: getWrapper({}) });

describe('useCanWritePlaylists', () => {
  beforeEach(() => {
    jest.mocked(contextSrv.hasPermission).mockReturnValue(false);
    (contextSrv as jest.Mocked<typeof contextSrv>).isEditor = false;
    setTestFlags({ playlistsRBAC: false });
  });

  afterEach(async () => {
    // Wrap in act() — setTestFlags fires OpenFeature events that trigger state updates
    // while the previous test's hook is still mounted (RTL cleanup runs afterward).
    await act(async () => {
      setTestFlags({});
    });
  });

  describe('with playlistsRBAC toggle off (legacy)', () => {
    it('returns true when user is an editor', () => {
      (contextSrv as jest.Mocked<typeof contextSrv>).isEditor = true;
      const { result } = renderUseCanWritePlaylists();
      expect(result.current).toBe(true);
    });

    it('returns false when user is not an editor', () => {
      const { result } = renderUseCanWritePlaylists();
      expect(result.current).toBe(false);
    });
  });

  describe('with playlistsRBAC toggle on', () => {
    beforeEach(() => {
      setTestFlags({ playlistsRBAC: true });
    });

    it('returns true when user has playlists:write', () => {
      jest
        .mocked(contextSrv.hasPermission)
        .mockImplementation((action) => action === AccessControlAction.PlaylistsWrite);
      const { result } = renderUseCanWritePlaylists();
      expect(result.current).toBe(true);
    });

    it('returns false when user lacks playlists:write, even if isEditor', () => {
      (contextSrv as jest.Mocked<typeof contextSrv>).isEditor = true;
      const { result } = renderUseCanWritePlaylists();
      expect(result.current).toBe(false);
    });
  });
});

/** A search hit in the shape a dashboard search returns it. */
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

/**
 * A search response holding `hits`, handed to the callback through one object the response rewrites
 * per row. That reuse is what a real search view does — it reads a data frame row by row — and it is
 * the reason `loadDashboards` copies every row out of the view it is given.
 */
function searchResponse(hits: DashboardQueryResult[]): QueryResponse {
  const row: Record<string, unknown> = {};
  return {
    view: {
      map: (fn: (hit: DashboardQueryResult, index: number) => unknown) =>
        hits.map((hit, index) => {
          for (const key of Object.keys(row)) {
            delete row[key];
          }
          return fn(Object.assign(row, hit) as unknown as DashboardQueryResult, index);
        }),
    },
    loadMoreItems: async () => {},
    isItemLoaded: () => true,
    totalRows: hits.length,
  } as unknown as QueryResponse;
}

/** The query `loadDashboards` builds for an item, with its selector filled in by the caller. */
function searchFor(selector: Pick<SearchQuery, 'uid'> | Pick<SearchQuery, 'tags'>): SearchQuery {
  return { query: '*', kind: ['dashboard'], limit: 1000, ...selector };
}

describe('loadDashboards', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockSearch.mockImplementation(async (query) => {
      const uid = query.uid?.[0];
      if (uid) {
        return searchResponse([dashboardHit(uid, `Dashboard ${uid}`)]);
      }
      const tag = query.tags?.[0] ?? '';
      return searchResponse([dashboardHit(`${tag}_1`, `First ${tag}`), dashboardHit(`${tag}_2`, `Second ${tag}`)]);
    });
  });

  it('returns an empty list and never searches when there are no items', async () => {
    await expect(loadDashboards([])).resolves.toEqual([]);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('searches once for every distinct type and value, and answers every item that shares one', async () => {
    // The same dashboard three times, each row with its own variables, plus a second dashboard and
    // a tag: five items, three things to look up.
    const items: PlaylistItemUI[] = [
      { type: 'dashboard_by_uid', value: 'uid_a', variables: { host: ['h1'] } },
      { type: 'dashboard_by_uid', value: 'uid_b' },
      { type: 'dashboard_by_uid', value: 'uid_a', variables: { host: ['h2'] } },
      { type: 'dashboard_by_tag', value: 'tag_x' },
      { type: 'dashboard_by_uid', value: 'uid_a' },
    ];

    const loaded = await loadDashboards(items);

    expect(mockSearch).toHaveBeenCalledTimes(3);
    expect(mockSearch.mock.calls.map(([query]) => query)).toEqual([
      searchFor({ uid: ['uid_a'] }),
      searchFor({ uid: ['uid_b'] }),
      searchFor({ tags: ['tag_x'] }),
    ]);

    // One result per item, at the item's own position, carrying the properties it came with.
    const dashboardA = [dashboardHit('uid_a', 'Dashboard uid_a')];
    expect(loaded).toEqual([
      { type: 'dashboard_by_uid', value: 'uid_a', variables: { host: ['h1'] }, dashboards: dashboardA },
      { type: 'dashboard_by_uid', value: 'uid_b', dashboards: [dashboardHit('uid_b', 'Dashboard uid_b')] },
      { type: 'dashboard_by_uid', value: 'uid_a', variables: { host: ['h2'] }, dashboards: dashboardA },
      {
        type: 'dashboard_by_tag',
        value: 'tag_x',
        dashboards: [dashboardHit('tag_x_1', 'First tag_x'), dashboardHit('tag_x_2', 'Second tag_x')],
      },
      { type: 'dashboard_by_uid', value: 'uid_a', dashboards: dashboardA },
    ]);
    // The items themselves are copies: an item may be owned by the RTK Query cache.
    expect(loaded[0]).not.toBe(items[0]);
    expect(items.every((item) => item.dashboards === undefined)).toBe(true);
  });

  it('copies each row out of the view the searcher hands back', async () => {
    const [loaded] = await loadDashboards([{ type: 'dashboard_by_tag', value: 'tag_x' }]);

    // A view reuses the object it yields per row, so two rows that came from one search must still
    // be two objects holding their own values.
    expect(loaded.dashboards).toHaveLength(2);
    expect(loaded.dashboards?.[0]).not.toBe(loaded.dashboards?.[1]);
    expect(loaded.dashboards?.map((dashboard) => dashboard.uid)).toEqual(['tag_x_1', 'tag_x_2']);
  });

  it('leaves the items a failed search answers with no dashboards and still loads the rest', async () => {
    mockSearch.mockImplementation(async (query) => {
      if (query.uid?.[0] === 'uid_missing') {
        throw new Error('search failed');
      }
      return searchResponse([dashboardHit('uid_a', 'Dashboard uid_a')]);
    });

    const loaded = await loadDashboards([
      { type: 'dashboard_by_uid', value: 'uid_missing' },
      { type: 'dashboard_by_uid', value: 'uid_a' },
      { type: 'dashboard_by_uid', value: 'uid_missing' },
    ]);

    expect(loaded).toEqual([
      { type: 'dashboard_by_uid', value: 'uid_missing', dashboards: [] },
      { type: 'dashboard_by_uid', value: 'uid_a', dashboards: [dashboardHit('uid_a', 'Dashboard uid_a')] },
      { type: 'dashboard_by_uid', value: 'uid_missing', dashboards: [] },
    ]);
    // The failing lookup is still one search for the two items that share it.
    expect(mockSearch).toHaveBeenCalledTimes(2);
  });

  it('rejects an item selected by numeric id without searching', async () => {
    await expect(
      loadDashboards([
        { type: 'dashboard_by_uid', value: 'uid_a' },
        { type: 'dashboard_by_id', value: '3' },
      ])
    ).rejects.toThrow('invalid item (with id)');
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
