import { configureStore } from '@reduxjs/toolkit';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Location } from 'history';
import { http, HttpResponse } from 'msw';

import { locationService, setBackendSrv } from '@grafana/runtime';
import server, { setupMockServer } from '@grafana/test-utils/server';
import { backendSrv } from 'app/core/services/backend_srv';
import { PlaylistSrv } from 'app/features/playlist/PlaylistSrv';
import { PlaylistTable } from 'app/features/playlist/PlaylistTable';
import { type PlaylistItemUI } from 'app/features/playlist/types';

import { playlistAPIv1, type Playlist, type PlaylistSpec } from './index';

setBackendSrv(backendSrv);
setupMockServer();

// `PlaylistSrv` plays whatever `loadDashboards` resolves each item to; the real one searches for
// dashboards and rejects `dashboard_by_id` outright, so a URL per item value is all playback needs
// here — and the rejection is why only a migrated playlist can be played at all.
jest.mock('app/features/playlist/utils', () => ({
  loadDashboards: (items: PlaylistItemUI[]) =>
    Promise.resolve(items.map((item) => ({ ...item, dashboards: [{ url: `/url/to/${item.value}` }] }))),
}));

const PLAYLIST_NAME = 'playlist_1';

/**
 * The playlist as the API serves it: a deprecated `dashboard_by_id` item that carries variables —
 * which the additive, optional schema permits — followed by the `dashboard_by_uid` item the feature
 * actually supports and a tag item. Rebuilt per call because the transform mutates the response.
 */
function apiPlaylist(): Playlist {
  return {
    apiVersion: 'playlist.grafana.app/v1',
    kind: 'Playlist',
    metadata: { name: PLAYLIST_NAME },
    spec: {
      interval: '1s',
      title: 'A migrated playlist',
      items: [
        { type: 'dashboard_by_id', value: '3', variables: { host: ['Host1'] } },
        { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Host2'] } },
        { type: 'dashboard_by_tag', value: 'graph-ng' },
      ],
    },
    status: {},
  };
}

/**
 * Runs the real `getPlaylist` endpoint, so the response passes through the endpoint's own
 * `transformResponse` rather than through a copy of it invoked directly.
 */
async function getTransformedPlaylist(): Promise<Playlist> {
  server.use(
    http.get(`/apis/playlist.grafana.app/v1/namespaces/:namespace/playlists/${PLAYLIST_NAME}`, () =>
      HttpResponse.json(apiPlaylist())
    ),
    http.get('/api/dashboards/ids/3', () => HttpResponse.json(['uid_3']))
  );

  const store = configureStore({
    reducer: {
      [playlistAPIv1.reducerPath]: playlistAPIv1.reducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(playlistAPIv1.middleware),
  });

  const subscription = store.dispatch(playlistAPIv1.endpoints.getPlaylist.initiate({ name: PLAYLIST_NAME }));
  const { data, error } = await subscription;
  subscription.unsubscribe();

  if (!data) {
    throw new Error(`getPlaylist did not fulfil: ${JSON.stringify(error)}`);
  }
  return data;
}

/**
 * The `MemoryHistory` that records the visited URLs is not part of the `LocationService`
 * interface, so the cast reaching it is confined to this helper.
 */
function historyEntries(): Location[] {
  const history = locationService.getHistory();
  return (history as unknown as { base: { entries: Location[] } }).base.entries;
}

function visitedUrls(count: number): string[] {
  return historyEntries()
    .slice(-count)
    .map((entry) => entry.pathname + entry.search);
}

type LoadedDashboard = NonNullable<PlaylistItemUI['dashboards']>[number];

function loadedDashboard(uid: string): LoadedDashboard {
  return {
    kind: 'dashboard',
    name: `Dashboard ${uid}`,
    uid,
    url: `/d/${uid}`,
    panel_type: '',
    tags: [],
    location: 'General',
    ds_uid: [],
    score: 0,
    explain: {},
  };
}

/**
 * The rows the playlist editor holds once its dashboards have resolved. Every row is given one,
 * because a row still waiting for its dashboards renders a spinner instead of its name.
 */
function editorRows(items: PlaylistSpec['items']): PlaylistItemUI[] {
  return items.map((item) => ({ ...item, dashboards: [loadedDashboard(item.value)] }));
}

function itemCell(type: string, value: string) {
  return screen.getByRole('cell', { name: `Playlist item, ${type}, ${value}` });
}

function disclosureButtons() {
  return screen.getAllByRole('button', { name: 'Template variables' });
}

describe('playlistAPIv1 getPlaylist deprecated-id migration', () => {
  it('migrates a dashboard_by_id item to its uid and drops the variables it carried', async () => {
    const playlist = await getTransformedPlaylist();

    // `toStrictEqual` rather than `toEqual`: the contract is that the migrated item has no
    // `variables` property at all, and `toEqual` would also accept one present but undefined.
    expect(playlist.spec.items).toStrictEqual<PlaylistSpec['items']>([
      { type: 'dashboard_by_uid', value: 'uid_3' },
      { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Host2'] } },
      { type: 'dashboard_by_tag', value: 'graph-ng' },
    ]);
  });

  it('plays the migrated item with no var- parameter and the uid item with its own', async () => {
    const playlist = await getTransformedPlaylist();
    locationService.push(`/playlists/${PLAYLIST_NAME}`);
    const srv = new PlaylistSrv();

    await srv.start(playlist);
    srv.next();
    srv.next();
    srv.stop();

    expect(visitedUrls(3)).toEqual(['/url/to/uid_3', '/url/to/uid_1?var-host=Host2', '/url/to/graph-ng']);
  });

  it('offers an empty variables editor on the migrated row and the stored variable on the uid row', async () => {
    const playlist = await getTransformedPlaylist();
    const user = userEvent.setup();

    render(
      <PlaylistTable
        items={editorRows(playlist.spec.items)}
        deleteItem={jest.fn()}
        moveItem={jest.fn()}
        onVariablesChange={jest.fn()}
      />
    );

    expect(within(itemCell('dashboard_by_uid', 'uid_1')).getByText('1 variable')).toBeInTheDocument();
    expect(within(itemCell('dashboard_by_uid', 'uid_3')).queryByText('1 variable')).not.toBeInTheDocument();
    expect(disclosureButtons()).toHaveLength(2);

    await user.click(disclosureButtons()[0]);

    const migratedPanel = screen.getByRole('region', { name: 'Template variables for uid_3' });
    // The add row's own two inputs and nothing else: a committed variable would add a labelled
    // name and values input of its own to the panel.
    expect(within(migratedPanel).getAllByRole('textbox')).toHaveLength(2);
    expect(within(migratedPanel).getByRole('textbox', { name: 'Variable name' })).toHaveValue('');
    expect(within(migratedPanel).getByRole('textbox', { name: 'Values (comma-separated)' })).toHaveValue('');

    await user.click(disclosureButtons()[1]);

    const uidPanel = screen.getByRole('region', { name: 'Template variables for uid_1' });
    expect(within(uidPanel).getByRole('textbox', { name: 'Variable name for host' })).toHaveValue('host');
    expect(within(uidPanel).getByRole('textbox', { name: 'Values for host' })).toHaveValue('Host2');
  });
});
