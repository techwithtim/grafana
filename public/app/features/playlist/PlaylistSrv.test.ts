import { type Store } from 'redux';
import configureMockStore from 'redux-mock-store';

import { locationService, logWarning } from '@grafana/runtime';
import { appEvents } from 'app/core/app_events';
import { setStore } from 'app/store/store';

import { type Playlist, type PlaylistSpec } from '../../api/clients/playlist/v1';
import { type DashboardQueryResult } from '../search/service/types';

import { PlaylistSrv } from './PlaylistSrv';
import { type PlaylistItemUI } from './types';
import { loadDashboards } from './utils';
import {
  MAX_ENCODED_VARIABLES_LENGTH,
  MAX_VALUES_PER_VARIABLE,
  MAX_VARIABLE_NAME_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  MAX_VARIABLES_PER_ITEM,
} from './variableLimits';

// Only the warning is replaced. Everything else the service uses from this module, the real
// locationService above all, stays exactly as it is, because the cases below assert on the URLs it
// actually records.
jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  logWarning: jest.fn(),
}));

jest.mock('./utils', () => ({
  loadDashboards: jest.fn((items: PlaylistItemUI[]) => {
    return Promise.resolve(
      items.map((v) => ({
        ...v,
        dashboards: [{ url: `/url/to/${v.value}` } as unknown as DashboardQueryResult],
      }))
    );
  }),
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

  // jsdom's window.location cannot be reassigned, so the property is deleted before being replaced
  Reflect.deleteProperty(win, 'location');

  win.location = {} as Location;

  // The double implements only href; any other Location member a test needs must be added here explicitly
  Object.defineProperty(window.location, 'href', {
    set: hrefMock,
    get: hrefMock,
  });
  const unmock = () => {
    win.location = oldLocation;
  };
  return [hrefMock, unmock];
};

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

// Exactly at, and exactly one over, each per-variable maximum. The values are alphanumeric so that
// what is counted against the URL budget and what is written into the query are the same length.
const nameAtLimit = 'n'.repeat(MAX_VARIABLE_NAME_LENGTH);
const nameOverLimit = 'n'.repeat(MAX_VARIABLE_NAME_LENGTH + 1);
const valueAtLimit = 'v'.repeat(MAX_VARIABLE_VALUE_LENGTH);
const valueOverLimit = 'v'.repeat(MAX_VARIABLE_VALUE_LENGTH + 1);
const valuesAtLimit = Array.from({ length: MAX_VALUES_PER_VARIABLE }, (_, index) => `v${index}`);
const valuesOverLimit = Array.from({ length: MAX_VALUES_PER_VARIABLE + 1 }, (_, index) => `v${index}`);

// The total URL budget charges a pair for `var-<name>=` plus the encoded value of each of its
// values, for the `&` joining those parameters to each other, and for the one that would join the
// pair to whatever follows it. With the one-character name `k` and alphanumeric values, which
// encode to themselves, that is exactly `count * ('var-k='.length + length + 1)` — so eight values
// of this length cost the whole budget and leave room for nothing else.
const BUDGET_PAIR_VALUE_COUNT = 8;
const BUDGET_PAIR_VALUE_LENGTH = MAX_ENCODED_VARIABLES_LENGTH / BUDGET_PAIR_VALUE_COUNT - 'var-k='.length - 1;

// Four characters per value below that, which leaves exactly 32 characters of the budget: enough
// for the 28 a single `[object Object]` value costs as playback writes it (`var-x=`, the twenty-one
// characters of `%5Bobject%20Object%5D`, and the joining `&`), and nowhere near the 236 the map
// form of the serializer counts for the same value by decomposing it one character per parameter.
const FILLER_PAIR_VALUE_LENGTH = BUDGET_PAIR_VALUE_LENGTH - 4;

// Distinct values of an exact length, so what is emitted, and in which order, is asserted rather
// than assumed. `padStart` pads with `v` and never truncates, so each value is `length` characters.
function budgetPairValues(length: number): string[] {
  return Array.from({ length: BUDGET_PAIR_VALUE_COUNT }, (_, index) => String(index).padStart(length, 'v'));
}

// One code point each, but not one UTF-16 code unit each: `é` is one unit and `𝄞` is two, so a
// limit measured with `String.prototype.length` refuses strings of these that the schema, and the
// API enforcing it, accept. Neither is one character once encoded either — `é` costs six and `𝄞`
// twelve — which is why the cases below give an item one variable wherever the URL budget would
// otherwise be the rule that decides the outcome.
const BMP_CHARACTER = 'é';
const ASTRAL_CHARACTER = '𝄞';

// The two characters above, and the cases the encoder expands, are exercised for both a name and a
// value, so each case names the character it builds its strings from.
const nonAsciiCharacters: Array<{ desc: string; character: string }> = [
  { desc: 'a non-ASCII character from the basic plane', character: BMP_CHARACTER },
  { desc: 'an astral character', character: ASTRAL_CHARACTER },
];

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

// The URL the srv treats as its own is private, so the cast reaching it lives here only.
function getValidPlaylistUrl(srv: PlaylistSrv): string {
  return (srv as unknown as { validPlaylistUrl: string }).validPlaylistUrl;
}

/**
 * The `var-` parameters of a pushed search string, exactly as they were written into it.
 *
 * The budget is a budget on characters of the pushed URL, so the cases that assert it read the
 * string the history entry holds rather than re-encoding the variables themselves — the whole
 * point of the limit is what the browser and any proxy in front of it receive.
 */
function varPortionOf(search: string): string {
  return search
    .slice(1)
    .split('&')
    .filter((param) => param.startsWith('var-'))
    .join('&');
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
    const publishSpy = jest.spyOn(appEvents, 'publish');

    await srv.start(mockPlaylist);

    locationService.push('/datasources');

    expect(srv.state.isPlaying).toBe(false);
    // A playlist that ends because the viewer went somewhere else says so, rather than leaving the
    // playback controls to vanish without explanation.
    expect(publishSpy).toHaveBeenCalledWith({
      type: 'alert-info',
      payload: ['Playlist stopped', 'Navigating away from a playlist dashboard ends the playlist.'],
    });
  });

  it('does not announce a stop that the viewer asked for', async () => {
    await srv.start(mockPlaylist);
    const publishSpy = jest.spyOn(appEvents, 'publish');

    srv.stop();

    expect(srv.state.isPlaying).toBe(false);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('stops playback and explains why when the browser goes back to the entry of another item', async () => {
    const publishSpy = jest.spyOn(appEvents, 'publish');

    // Both items play the same dashboard, which is the case a pathname comparison cannot see: the
    // entry the browser goes back to has the pathname the playlist considers its own.
    await srv.start(
      playlistWithItems([
        { type: 'dashboard_by_uid', value: 'aaa', variables: { host: ['one'] } },
        { type: 'dashboard_by_uid', value: 'aaa', variables: { host: ['two'] } },
      ])
    );
    srv.next();
    expect(getLastHistoryEntry().search).toBe('?var-host=two');

    locationService.getHistory().goBack();

    expect(srv.state.isPlaying).toBe(false);
    expect(publishSpy).toHaveBeenCalledWith({
      type: 'alert-info',
      payload: ['Playlist stopped', 'Navigating away from a playlist dashboard ends the playlist.'],
    });
  });

  it('stops playback when the browser goes back out of the playlist entirely', async () => {
    await srv.start(mockPlaylist);

    locationService.getHistory().goBack();

    expect(srv.state.isPlaying).toBe(false);
  });

  it('storeUpdated should not stop playlist when navigating to next dashboard', async () => {
    await srv.start(mockPlaylist);

    expect(getValidPlaylistUrl(srv)).toBe('/url/to/aaa');

    srv.next();

    expect(getValidPlaylistUrl(srv)).toBe('/url/to/bbb');
    expect(srv.state.isPlaying).toBe(true);
  });

  it('should replace playlist start page in history when starting playlist', async () => {
    locationService.push('/playlists');

    locationService.push('/playlists/play/foo');

    await srv.start(mockPlaylist);

    const entries = getHistoryEntries();

    expect(entries[entries.length - 1].pathname).toBe('/url/to/aaa');

    expect(entries[entries.length - 2].pathname).toBe('/playlists');

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

  it('emits a value of "[object Object]" as a single parameter instead of decomposing it', async () => {
    await srv.start(
      playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { x: ['[object Object]'] } }])
    );

    const { search } = getLastHistoryEntry();
    expect(search).toBe('?var-x=%5Bobject%20Object%5D');
    expect(new URLSearchParams(search).getAll('var-x')).toEqual(['[object Object]']);
  });

  it('emits one parameter per value when a multi-value variable contains "[object Object]"', async () => {
    await srv.start(
      playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { x: ['[object Object]', 'plain'] } }])
    );

    const { search } = getLastHistoryEntry();
    expect(search).toBe('?var-x=%5Bobject%20Object%5D&var-x=plain');
    expect(new URLSearchParams(search).getAll('var-x')).toEqual(['[object Object]', 'plain']);
  });

  it('percent-encodes a variable name of "[object Object]" into a single key', async () => {
    await srv.start(
      playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { '[object Object]': ['v'] } }])
    );

    const { search } = getLastHistoryEntry();
    expect(search).toBe('?var-%5Bobject%20Object%5D=v');
    expect(Array.from(new URLSearchParams(search).keys())).toEqual(['var-[object Object]']);
  });

  it.each<{ desc: string; variables: Record<string, string[]> }>([
    { desc: 'an empty variable name', variables: { '': ['x'], host: ['a'] } },
    { desc: 'a whitespace-only variable name', variables: { '   ': ['x'], host: ['a'] } },
    { desc: 'a variable with an empty value list', variables: { empty: [], host: ['a'] } },
    // U+200B is not whitespace to `trim()` in either language, so before the shared blank-name
    // rule it reached the URL as an invisible `var-%E2%80%8B` parameter. U+FEFF is stripped by
    // `trim()` but not by Go's, so it was stored and then silently skipped here. Both are now
    // refused on write and skipped here, which is what makes the layers agree.
    { desc: 'a zero-width-space variable name', variables: { '\u200b': ['x'], host: ['a'] } },
    { desc: 'a byte-order-mark variable name', variables: { '\ufeff': ['x'], host: ['a'] } },
    { desc: 'a soft-hyphen variable name', variables: { '\u00ad': ['x'], host: ['a'] } },
    { desc: 'a control-character variable name', variables: { '\u0001': ['x'], host: ['a'] } },
    {
      desc: 'a variable name of mixed invisible characters',
      variables: { '\u200b\u2060 \t': ['x'], host: ['a'] },
    },
  ])('skips $desc and emits only the valid var- parameter', async ({ variables }) => {
    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables }]));

    expect(getLastHistoryEntry().search).toBe('?var-host=a');
  });

  it('applies a variable whose name only starts with an invisible character', async () => {
    // The blank-name rule refuses a name made of invisible characters, not one that contains
    // any: a name with something visible in it is a name, and dropping it would silently stop
    // applying a variable the dashboard can resolve.
    await srv.start(
      playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { '\u200bhost': ['a'] } }])
    );

    const { search } = getLastHistoryEntry();
    expect(search).toBe('?var-%E2%80%8Bhost=a');
    expect(new URLSearchParams(search).getAll('var-\u200bhost')).toEqual(['a']);
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

  it('reports a playlist it started', async () => {
    const result = await srv.start(mockPlaylist);

    expect(result).toEqual({ started: true });
    expect(srv.state.isPlaying).toBe(true);
  });

  it('reports the reason, stays stopped and adds no history entry for a playlist with no items', async () => {
    const entryCountBefore = getHistoryEntries().length;
    const entryBefore = getLastHistoryEntry();

    const result = await srv.start(playlistWithItems([]));

    expect(result).toEqual({ started: false, failureReason: 'no-items' });
    // Reporting a playlist as playing when it has nothing to play is what left the start page blank:
    // the page could not explain itself and the toolbar showed controls for a playlist going nowhere.
    expect(srv.state.isPlaying).toBe(false);
    expect(getHistoryEntries()).toHaveLength(entryCountBefore);
    expect(getLastHistoryEntry()).toBe(entryBefore);
  });

  it('reports the reason, stays stopped and adds no history entry when no item resolves to a dashboard', async () => {
    // The default stub resolves one dashboard per item, while a search that matches nothing resolves
    // the item with an empty dashboard list, which is what leaves the playlist with no entries.
    jest.mocked(loadDashboards).mockResolvedValueOnce([{ type: 'dashboard_by_uid', value: 'aaa', dashboards: [] }]);
    const entryCountBefore = getHistoryEntries().length;
    const entryBefore = getLastHistoryEntry();

    const result = await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa' }]));

    expect(result).toEqual({ started: false, failureReason: 'no-dashboards' });
    expect(srv.state.isPlaying).toBe(false);
    expect(getHistoryEntries()).toHaveLength(entryCountBefore);
    expect(getLastHistoryEntry()).toBe(entryBefore);
  });

  it('navigates nowhere when a control is used after a start that found no dashboards', async () => {
    jest.mocked(loadDashboards).mockResolvedValueOnce([{ type: 'dashboard_by_uid', value: 'aaa', dashboards: [] }]);
    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa' }]));
    const entryCountBefore = getHistoryEntries().length;

    srv.next();
    srv.prev();

    expect(getHistoryEntries()).toHaveLength(entryCountBefore);
    // The one call is start() reading the current href; a reload would be a second, setting one.
    expect(hrefMock).toHaveBeenCalledTimes(1);
    expect(srv.state.isPlaying).toBe(false);
  });

  it('leaves no previous playlist to replay when a later start finds no dashboards', async () => {
    await srv.start(mockPlaylist);
    expect(srv.state.isPlaying).toBe(true);

    jest.mocked(loadDashboards).mockResolvedValueOnce([{ type: 'dashboard_by_uid', value: 'zzz', dashboards: [] }]);
    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'zzz' }]));
    const entryCountBefore = getHistoryEntries().length;

    srv.next();

    expect(getHistoryEntries()).toHaveLength(entryCountBefore);
    expect(srv.state.isPlaying).toBe(false);
  });

  it('goes back to the last item when prev is used on the first item', async () => {
    await srv.start(
      playlistWithItems([
        { type: 'dashboard_by_uid', value: 'aaa' },
        { type: 'dashboard_by_uid', value: 'bbb' },
        { type: 'dashboard_by_uid', value: 'ccc' },
      ])
    );

    expect(getLastHistoryEntry().pathname).toBe('/url/to/aaa');

    srv.prev();

    expect(getLastHistoryEntry().pathname).toBe('/url/to/ccc');
    expect(getValidPlaylistUrl(srv)).toBe('/url/to/ccc');
    expect(srv.state.isPlaying).toBe(true);
  });

  it('goes back exactly one item when prev is used past the first item', async () => {
    await srv.start(
      playlistWithItems([
        { type: 'dashboard_by_uid', value: 'aaa' },
        { type: 'dashboard_by_uid', value: 'bbb' },
        { type: 'dashboard_by_uid', value: 'ccc' },
      ])
    );

    srv.next();
    expect(getLastHistoryEntry().pathname).toBe('/url/to/bbb');

    srv.prev();

    expect(getLastHistoryEntry().pathname).toBe('/url/to/aaa');
    expect(srv.state.isPlaying).toBe(true);
  });

  it('completes no loop, and so never reloads, when prev wraps to the last item', async () => {
    await srv.start(mockPlaylist);

    srv.prev();
    srv.prev();
    srv.prev();

    // Only start()'s read of the current href; the reload sets it, so a wrap that counted a loop
    // would show up here as a second call.
    expect(hrefMock).toHaveBeenCalledTimes(1);
    expect(srv.state.isPlaying).toBe(true);
  });

  it('keeps playing the only item of a one-item playlist through both directional controls', async () => {
    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { host: ['a'] } }]));
    const entryCountAfterStart = getHistoryEntries().length;

    srv.next();
    srv.prev();

    const entries = getHistoryEntries();
    expect(entries).toHaveLength(entryCountAfterStart + 2);
    expect(entries[entries.length - 1].pathname).toBe('/url/to/aaa');
    expect(entries[entries.length - 1].search).toBe('?var-host=a');
    expect(srv.state.isPlaying).toBe(true);
  });

  it('drops kiosk from the reload URL once the viewer has left kiosk mode', async () => {
    hrefMock.mockReturnValue('http://localhost/playlists/play/foo?kiosk=true');
    locationService.push('/playlists/play/foo?kiosk=true');

    await srv.start(mockPlaylist);
    expect(getLastHistoryEntry().search).toBe('?kiosk=true');

    // What pressing Escape does: kiosk leaves the URL, and playback carries on without it.
    locationService.partial({ kiosk: null });
    expect(srv.state.isPlaying).toBe(true);

    for (let i = 0; i < 6; i++) {
      srv.next();
    }

    expect(hrefMock).toHaveBeenLastCalledWith('http://localhost/playlists/play/foo');
  });

  it('keeps the playback options of the live URL in the reload URL', async () => {
    hrefMock.mockReturnValue('http://localhost/playlists/play/foo?kiosk=true&_dash.hideVariables=true');
    locationService.push('/playlists/play/foo?kiosk=true&_dash.hideVariables=true');

    await srv.start(mockPlaylist);

    for (let i = 0; i < 6; i++) {
      srv.next();
    }

    expect(hrefMock).toHaveBeenLastCalledWith(
      'http://localhost/playlists/play/foo?kiosk=true&_dash.hideVariables=true'
    );
  });

  it('applies a variable name, a value count and a value length that sit exactly on their limits', async () => {
    await srv.start(
      playlistWithItems([
        {
          type: 'dashboard_by_uid',
          value: 'aaa',
          variables: { [nameAtLimit]: ['ok'], many: valuesAtLimit, big: [valueAtLimit] },
        },
      ])
    );

    const params = new URLSearchParams(getLastHistoryEntry().search);
    expect(params.getAll(`var-${nameAtLimit}`)).toEqual(['ok']);
    expect(params.getAll('var-many')).toEqual(valuesAtLimit);
    expect(params.getAll('var-big')).toEqual([valueAtLimit]);
    expect(srv.state.isPlaying).toBe(true);
  });

  it.each<{ desc: string; variables: Record<string, string[]> }>([
    { desc: 'a name one character over the limit', variables: { [nameOverLimit]: ['x'], host: ['a'] } },
    { desc: 'one value more than the limit', variables: { many: valuesOverLimit, host: ['a'] } },
    { desc: 'a value one character over the limit', variables: { big: [valueOverLimit], host: ['a'] } },
  ])('drops the variable with $desc and keeps the in-budget variables of the same item', async ({ variables }) => {
    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables }]));

    // The whole pair is dropped rather than truncated, and playback is not interrupted by it.
    expect(getLastHistoryEntry().search).toBe('?var-host=a');
    expect(srv.state.isPlaying).toBe(true);
  });

  it('applies the variables an item may hold and drops the one past that count', async () => {
    const variables: Record<string, string[]> = {};
    for (let index = 0; index <= MAX_VARIABLES_PER_ITEM; index++) {
      variables[`k${index}`] = ['v'];
    }

    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables }]));

    const params = new URLSearchParams(getLastHistoryEntry().search);
    expect(Array.from(params.keys())).toHaveLength(MAX_VARIABLES_PER_ITEM);
    expect(params.getAll(`var-k${MAX_VARIABLES_PER_ITEM - 1}`)).toEqual(['v']);
    expect(params.has(`var-k${MAX_VARIABLES_PER_ITEM}`)).toBe(false);
    expect(srv.state.isPlaying).toBe(true);
  });

  it('keeps the var- portion of the pushed URL inside the total budget when the variables together exceed it', async () => {
    // Every variable here is in budget on its own and costs 1033 characters of the total: 4 for
    // `var-`, 3 for the name, 1 for `=`, the value's 1024, and the separator it is joined with.
    // Seven of them fit inside 8192 and the eighth does not, so the rest of the item is dropped.
    const variables: Record<string, string[]> = {};
    for (let index = 0; index < 20; index++) {
      variables[`k${String(index).padStart(2, '0')}`] = [valueAtLimit];
    }

    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables }]));

    const { search } = getLastHistoryEntry();
    expect(varPortionOf(search).length).toBeLessThanOrEqual(MAX_ENCODED_VARIABLES_LENGTH);
    expect(Array.from(new URLSearchParams(search).keys())).toHaveLength(7);
    expect(srv.state.isPlaying).toBe(true);
  });

  it('applies a variable whose measured cost is exactly the total budget', async () => {
    const values = budgetPairValues(BUDGET_PAIR_VALUE_LENGTH);

    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { k: values } }]));

    const { search } = getLastHistoryEntry();
    expect(new URLSearchParams(search).getAll('var-k')).toEqual(values);
    // The pair is charged for the `&` that would join it to a next parameter, and it is the last
    // one here, so a pair sitting exactly on the budget writes one character less than the budget.
    expect(varPortionOf(search).length).toBe(MAX_ENCODED_VARIABLES_LENGTH - 1);
    expect(logWarning).not.toHaveBeenCalled();
    expect(srv.state.isPlaying).toBe(true);
  });

  it('drops a variable whose measured cost is one character past the total budget', async () => {
    const values = budgetPairValues(BUDGET_PAIR_VALUE_LENGTH);
    // One character more than the case above, and still well inside the per-value maximum, so the
    // total budget is the only rule that can refuse it.
    values[values.length - 1] += 'v';

    await srv.start(
      playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { k: values, host: ['a'] } }])
    );

    expect(getLastHistoryEntry().search).toBe('?var-host=a');
    expect(logWarning).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(expect.any(String), {
      appliedVariables: '1',
      droppedVariables: '1',
      variablesLeftUninspected: 'false',
    });
    expect(srv.state.isPlaying).toBe(true);
  });

  it('applies a single "[object Object]" value that fits the budget left over, costing what it is written as', async () => {
    // Only a budget measured in the form playback emits admits this: the map form of the serializer
    // decomposes the value into one parameter per character and charges 236 characters for the 28
    // it writes, which is more than the filler leaves and would drop a pair that fits.
    const filler = budgetPairValues(FILLER_PAIR_VALUE_LENGTH);

    await srv.start(
      playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { k: filler, x: ['[object Object]'] } }])
    );

    const { search } = getLastHistoryEntry();
    const params = new URLSearchParams(search);
    expect(params.getAll('var-k')).toEqual(filler);
    expect(params.getAll('var-x')).toEqual(['[object Object]']);
    // Two names only: an indexed `var-x[0]`-style parameter would mean the value was decomposed.
    expect(Array.from(new Set(params.keys()))).toEqual(['var-k', 'var-x']);
    expect(varPortionOf(search).length).toBeLessThanOrEqual(MAX_ENCODED_VARIABLES_LENGTH);
    expect(logWarning).not.toHaveBeenCalled();
    expect(srv.state.isPlaying).toBe(true);
  });

  it('applies every value of a variable holding the maximum number of "[object Object]" values', async () => {
    const values = Array.from({ length: MAX_VALUES_PER_VARIABLE }, () => '[object Object]');

    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { x: values } }]));

    const { search } = getLastHistoryEntry();
    const params = new URLSearchParams(search);
    expect(params.getAll('var-x')).toEqual(values);
    expect(Array.from(new Set(params.keys()))).toEqual(['var-x']);
    // 1791 characters as written; the map form of the serializer would have measured 15104 of them
    // and refused the pair outright.
    expect(varPortionOf(search).length).toBeLessThanOrEqual(MAX_ENCODED_VARIABLES_LENGTH);
    expect(logWarning).not.toHaveBeenCalled();
    expect(srv.state.isPlaying).toBe(true);
  });

  it.each<{ desc: string; characters: string }>([
    { desc: 'apostrophes', characters: "'" },
    { desc: 'the characters ! ( ) and *', characters: '!()*' },
  ])(
    'keeps the pushed var- query inside the total budget when the values are made of $desc',
    async ({ characters }) => {
      // The serializer encodes in the style of AngularJS, which turns each of these into a
      // three-character escape that `encodeURIComponent` leaves as one. Twenty variables of a
      // value at the per-value limit therefore emit around 60 KB of query, and the budget only
      // holds if what it measures is what is written: each of these values contributes 3072
      // characters, so at most two of them can be applied.
      const value = characters.repeat(MAX_VARIABLE_VALUE_LENGTH / characters.length);
      const variables: Record<string, string[]> = {};
      for (let index = 0; index < 20; index++) {
        variables[`k${String(index).padStart(2, '0')}`] = [value];
      }

      await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables }]));

      const { search } = getLastHistoryEntry();
      const varPortion = varPortionOf(search);
      expect(varPortion.length).toBeLessThanOrEqual(MAX_ENCODED_VARIABLES_LENGTH);
      // Playback still applies what fits, so the assertion above is not passing on an empty query.
      expect(varPortion.length).toBeGreaterThan(0);
      expect(new URLSearchParams(search).getAll('var-k00')).toEqual([value]);
      expect(srv.state.isPlaying).toBe(true);
    }
  );

  it('pushes only the variables an item may hold, and keeps playing, for a map of thousands of keys', async () => {
    const variables: Record<string, string[]> = {};
    for (let index = 0; index < 5000; index++) {
      variables[`k${String(index).padStart(4, '0')}`] = ['v'];
    }

    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables }]));

    const params = new URLSearchParams(getLastHistoryEntry().search);
    expect(Array.from(params.keys())).toHaveLength(MAX_VARIABLES_PER_ITEM);
    expect(params.getAll('var-k0000')).toEqual(['v']);
    expect(params.has(`var-k${String(MAX_VARIABLES_PER_ITEM).padStart(4, '0')}`)).toBe(false);
    expect(srv.state.isPlaying).toBe(true);
    // The walk stops at the item's variable maximum, so the counts alone would claim nothing was
    // over budget. The flag is what says the remaining keys were never looked at, and the context
    // carries nothing else — a name or a value is exactly what must not reach telemetry.
    expect(logWarning).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(expect.any(String), {
      appliedVariables: String(MAX_VARIABLES_PER_ITEM),
      droppedVariables: '0',
      variablesLeftUninspected: 'true',
    });
  });

  it.each(nonAsciiCharacters)(
    'applies a variable whose name is exactly the limit in code points of $desc',
    async ({ character }) => {
      const name = character.repeat(MAX_VARIABLE_NAME_LENGTH);

      await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { [name]: ['ok'] } }]));

      expect(new URLSearchParams(getLastHistoryEntry().search).getAll(`var-${name}`)).toEqual(['ok']);
      expect(srv.state.isPlaying).toBe(true);
    }
  );

  it.each(nonAsciiCharacters)(
    'drops a variable whose name is one code point over the limit in $desc',
    async ({ character }) => {
      const name = character.repeat(MAX_VARIABLE_NAME_LENGTH + 1);

      await srv.start(
        playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { [name]: ['ok'], host: ['a'] } }])
      );

      expect(getLastHistoryEntry().search).toBe('?var-host=a');
      expect(srv.state.isPlaying).toBe(true);
    }
  );

  it('applies a value that is exactly the limit in code points of a basic-plane character', async () => {
    const value = BMP_CHARACTER.repeat(MAX_VARIABLE_VALUE_LENGTH);

    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { big: [value] } }]));

    expect(new URLSearchParams(getLastHistoryEntry().search).getAll('var-big')).toEqual([value]);
    expect(srv.state.isPlaying).toBe(true);
  });

  it('applies an astral value that only a UTF-16 measurement of the limit would refuse', async () => {
    // Half the limit plus one astral characters are two code units past the limit as `length`
    // counts it, and just over half of it in the code points the limit is stated in. The astral
    // value at exactly the limit belongs to the editor's suite: twelve encoded characters each put
    // 1024 of them past the URL budget, which is the case below.
    const value = ASTRAL_CHARACTER.repeat(MAX_VARIABLE_VALUE_LENGTH / 2 + 1);

    await srv.start(playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { big: [value] } }]));

    expect(new URLSearchParams(getLastHistoryEntry().search).getAll('var-big')).toEqual([value]);
    expect(srv.state.isPlaying).toBe(true);
  });

  it('leaves out an astral value at the code-point limit because its encoded form exceeds the URL budget', async () => {
    const value = ASTRAL_CHARACTER.repeat(MAX_VARIABLE_VALUE_LENGTH);

    await srv.start(
      playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { big: [value], host: ['a'] } }])
    );

    // The value is within every per-variable maximum; what refuses it is the total encoded budget,
    // and the item plays with the variable that fits.
    expect(getLastHistoryEntry().search).toBe('?var-host=a');
    expect(srv.state.isPlaying).toBe(true);
  });

  it.each(nonAsciiCharacters)('drops a value one code point over the limit in $desc', async ({ character }) => {
    const value = character.repeat(MAX_VARIABLE_VALUE_LENGTH + 1);

    await srv.start(
      playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { big: [value], host: ['a'] } }])
    );

    expect(getLastHistoryEntry().search).toBe('?var-host=a');
    expect(srv.state.isPlaying).toBe(true);
  });

  it('pushes the same search string for an in-budget item as it did before the budget existed', async () => {
    await srv.start(
      playlistWithItems([{ type: 'dashboard_by_uid', value: 'aaa', variables: { host: ['a', 'b'], region: ['eu'] } }])
    );

    expect(getLastHistoryEntry().search).toBe('?var-host=a&var-host=b&var-region=eu');
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
