import { type Store } from 'redux';
import configureMockStore from 'redux-mock-store';

import { locationService } from '@grafana/runtime';
import { setStore } from 'app/store/store';

import { type Playlist, type PlaylistSpec } from '../../api/clients/playlist/v1';
import { type DashboardQueryResult } from '../search/service/types';

import { PlaylistSrv } from './PlaylistSrv';
import { type PlaylistItemUI } from './types';

jest.mock('./utils', () => ({
  loadDashboards: (items: PlaylistItemUI[]) => {
    return Promise.resolve(
      items.map((v) => ({
        ...v, // same item with dashboard URLs filled in
        dashboards: [{ url: `/url/to/${v.value}` } as unknown as DashboardQueryResult],
      }))
    );
  },
}));

const mockPlaylist: Playlist = {
  apiVersion: 'playlist.grafana.app/v1',
  kind: 'Playlist',
  spec: {
    interval: '1s',
    title: 'The display',
    items: [
      { type: 'dashboard_by_uid', value: 'aaa' },
      { type: 'dashboard_by_uid', value: 'bbb' },
    ],
  },
  metadata: {
    name: 'xyz',
  },
  status: {},
};

const mockStore = configureMockStore();

setStore(
  mockStore({
    location: {},
  }) as Store
);

function createPlaylistSrv(): PlaylistSrv {
  locationService.push('/playlists/foo');
  return new PlaylistSrv();
}

const mockWindowLocation = (): [jest.Mock, () => void] => {
  const win: typeof globalThis = window;
  const oldLocation = win.location;
  const hrefMock = jest.fn();

  // JSDom defines window in a way that you cannot tamper with location so this seems to be the only way to change it.
  // https://github.com/facebook/jest/issues/5124#issuecomment-446659510
  //@ts-ignore
  delete win.location;

  win.location = {} as Location;

  // Only mocking href as that is all this test needs, but otherwise there is lots of things missing, so keep that
  // in mind if this is reused.
  Object.defineProperty(window.location, 'href', {
    set: hrefMock,
    get: hrefMock,
  });
  const unmock = () => {
    win.location = oldLocation;
  };
  return [hrefMock, unmock];
};

// Kept separate from mockPlaylist so the cases that predate variables keep their original two-item fixture.
function playlistWithItems(items: PlaylistSpec['items']): Playlist {
  return {
    apiVersion: 'playlist.grafana.app/v1',
    kind: 'Playlist',
    spec: {
      interval: '1s',
      title: 'The display',
      items,
    },
    metadata: {
      name: 'xyz',
    },
    status: {},
  };
}

// The MemoryHistory that records the visited URLs is not part of the locationService interface, so the
// cast reaching it lives here only, rather than being repeated in every case that reads a pushed URL.
function getHistoryEntries(): Location[] {
  const history = locationService.getHistory();
  return (history as unknown as { base: { entries: Location[] } }).base.entries;
}

function getLastHistoryEntry(): Location {
  const entries = getHistoryEntries();
  return entries[entries.length - 1];
}

describe('PlaylistSrv', () => {
  let srv: PlaylistSrv;
  let hrefMock: jest.Mock;
  let unmockLocation: () => void;
  const initialUrl = 'http://localhost/playlist';

  beforeEach(() => {
    jest.clearAllMocks();

    srv = createPlaylistSrv();
    [hrefMock, unmockLocation] = mockWindowLocation();

    // This will be cached in the srv when start() is called
    hrefMock.mockReturnValue(initialUrl);
  });

  afterEach(() => {
    unmockLocation();
    jest.restoreAllMocks();
  });

  it('runs all dashboards in cycle and reloads page after 3 cycles', async () => {
    await srv.start(mockPlaylist);

    for (let i = 0; i < 6; i++) {
      srv.next();
    }

    expect(hrefMock).toHaveBeenCalledTimes(2);
    expect(hrefMock).toHaveBeenLastCalledWith(initialUrl);
  });

  it('keeps the refresh counter value after restarting', async () => {
    await srv.start(mockPlaylist);

    // 1 complete loop
    for (let i = 0; i < 3; i++) {
      srv.next();
    }

    srv.stop();
    await srv.start(mockPlaylist);

    // Another 2 loops
    for (let i = 0; i < 4; i++) {
      srv.next();
    }

    expect(hrefMock).toHaveBeenCalledTimes(3);
    expect(hrefMock).toHaveBeenLastCalledWith(initialUrl);
  });

  it('Should stop playlist when navigating away', async () => {
    await srv.start(mockPlaylist);

    locationService.push('/datasources');

    expect(srv.state.isPlaying).toBe(false);
  });

  it('storeUpdated should not stop playlist when navigating to next dashboard', async () => {
    await srv.start(mockPlaylist);

    // eslint-disable-next-line
    expect((srv as any).validPlaylistUrl).toBe('/url/to/aaa');

    srv.next();

    // eslint-disable-next-line
    expect((srv as any).validPlaylistUrl).toBe('/url/to/bbb');
    expect(srv.state.isPlaying).toBe(true);
  });

  it('should replace playlist start page in history when starting playlist', async () => {
    // Start at playlists page
    locationService.push('/playlists');

    // Navigate to playlist start page
    locationService.push('/playlists/play/foo');

    // Start the playlist
    await srv.start(mockPlaylist);

    // Get history entries via the underlying MemoryHistory (test-env only)
    const history = locationService.getHistory();
    const entries = (history as unknown as { base: { entries: Location[] } }).base.entries;

    // The current entry should be the first dashboard
    expect(entries[entries.length - 1].pathname).toBe('/url/to/aaa');

    // The previous entry should be the playlists page, not the start page
    expect(entries[entries.length - 2].pathname).toBe('/playlists');

    // Verify the start page (/playlists/play/foo) is not in history
    const hasStartPage = entries.some((entry: { pathname: string }) => entry.pathname === '/playlists/play/foo');
    expect(hasStartPage).toBe(false);
  });

  it('repeats the var- parameter once per value for an item with a multi-value variable', async () => {
    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { host: ['a', 'b'] } }]));

    const entry = getLastHistoryEntry();
    expect(entry.pathname).toBe('/url/to/aaa');
    expect(entry.search).toBe('?var-host=a&var-host=b');
  });

  it('emits no var- parameter and keeps only whitelisted parameters for an item without variables', async () => {
    locationService.push('/playlists/foo?orgId=3&from=now-5m');

    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa' }]));

    expect(getLastHistoryEntry().search).toBe('?orgId=3');
  });

  it('emits no var- parameter for a variable-less item that directly follows a variable-bearing item', async () => {
    await srv.start(
      playlistWithItems([
        { type: 'dashboard_by_uid', value: 'aaa', variables: { host: ['a'] } },
        { type: 'dashboard_by_uid', value: 'bbb' },
      ])
    );

    expect(getLastHistoryEntry().search).toBe('?var-host=a');

    srv.next();

    const entry = getLastHistoryEntry();
    expect(entry.pathname).toBe('/url/to/bbb');
    expect(entry.search).toBe('');
  });

  it('percent-encodes a variable value containing a space and reserved characters', async () => {
    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { x: ['a b&c=d'] } }]));

    expect(getLastHistoryEntry().search).toBe('?var-x=a%20b%26c%3Dd');
  });

  it('percent-encodes a variable name containing an ampersand so the query parses to a single key', async () => {
    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { 'h&y': ['v'] } }]));

    const { search } = getLastHistoryEntry();
    expect(search).toBe('?var-h%26y=v');
    expect(Array.from(new URLSearchParams(search).keys())).toEqual(['var-h&y']);
  });

  it.each<{ desc: string; variables: Record<string, string[]> }>([
    { desc: 'an empty variable name', variables: { '': ['x'], host: ['a'] } },
    { desc: 'a whitespace-only variable name', variables: { '   ': ['x'], host: ['a'] } },
    { desc: 'a variable with an empty value list', variables: { empty: [], host: ['a'] } },
  ])('skips $desc and emits only the valid var- parameter', async ({ variables }) => {
    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables }]));

    expect(getLastHistoryEntry().search).toBe('?var-host=a');
  });

  it('keeps kiosk from the starting location but drops a var- parameter already in the URL', async () => {
    locationService.push('/playlists/foo?kiosk&var-host=old');

    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { host: ['a', 'b'] } }]));

    expect(getLastHistoryEntry().search).toBe('?kiosk=true&var-host=a&var-host=b');
  });

  it('emits no var- parameter for a dashboard_by_tag item that carries variables', async () => {
    await srv.start(playlistWithItems([{ type: 'dashboard_by_tag', value: 'graph-ng', variables: { host: ['a'] } }]));

    const entry = getLastHistoryEntry();
    expect(entry.pathname).toBe('/url/to/graph-ng');
    expect(entry.search).toBe('');
  });

  it('pushes a distinct URL and keeps playing for a second item on the same dashboard with different variables', async () => {
    // A second replace() would overwrite the current entry with a new location object carrying the
    // second item's URL, so the latest entry alone cannot tell a pushed record from an overwritten
    // one. The stack depth, the adjacent pair and the spied navigation methods can: replace() leaves
    // the entry count unchanged, push() adds one. The spies are created here, after beforeEach has
    // navigated to the playlist page, so the push count is still zero when the playlist starts.
    const replaceSpy = jest.spyOn(locationService, 'replace');
    const pushSpy = jest.spyOn(locationService, 'push');

    await srv.start(
      playlistWithItems([
        { type: 'dashboard_by_uid', value: 'aaa', variables: { host: ['one'] } },
        { type: 'dashboard_by_uid', value: 'aaa', variables: { host: ['two'] } },
      ])
    );

    const entryCountAfterStart = getHistoryEntries().length;
    const first = getLastHistoryEntry();
    expect(first.pathname).toBe('/url/to/aaa');
    expect(first.search).toBe('?var-host=one');
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith('/url/to/aaa?var-host=one');
    expect(pushSpy).toHaveBeenCalledTimes(0);

    srv.next();

    const entries = getHistoryEntries();
    expect(entries).toHaveLength(entryCountAfterStart + 1);
    expect(entries[entries.length - 2].pathname).toBe('/url/to/aaa');
    expect(entries[entries.length - 2].search).toBe('?var-host=one');
    expect(entries[entries.length - 1].pathname).toBe('/url/to/aaa');
    expect(entries[entries.length - 1].search).toBe('?var-host=two');
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith('/url/to/aaa?var-host=two');
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(srv.state.isPlaying).toBe(true);
  });

  it('reloads the page after 3 cycles when the items carry variables', async () => {
    await srv.start(
      playlistWithItems([
        { type: 'dashboard_by_uid', value: 'aaa', variables: { host: ['a'] } },
        { type: 'dashboard_by_uid', value: 'bbb', variables: { host: ['b'] } },
      ])
    );

    for (let i = 0; i < 6; i++) {
      srv.next();
    }

    expect(hrefMock).toHaveBeenCalledTimes(2);
    expect(hrefMock).toHaveBeenLastCalledWith(initialUrl);
  });
});
