import { screen, waitFor } from '@testing-library/react';
import { render } from 'test/test-utils';

import { type Playlist, useGetPlaylistQuery } from '../../api/clients/playlist/v1';

import { playlistSrv } from './PlaylistSrv';
import PlaylistStartPage from './PlaylistStartPage';

// The page's whole job is to turn the three states of the playlist query, and the outcome of the
// start attempt, into something the viewer can read and act on. Both are replaced here so each of
// those states can be rendered on its own; the transport behind the query is not what is under test.
jest.mock('../../api/clients/playlist/v1', () => ({
  useGetPlaylistQuery: jest.fn(),
}));

jest.mock('./PlaylistSrv', () => ({
  playlistSrv: {
    start: jest.fn(),
  },
}));

jest.mock('react-router-dom-v5-compat', () => ({
  ...jest.requireActual('react-router-dom-v5-compat'),
  useParams: () => ({ uid: 'playlist-uid' }),
}));

const playlist: Playlist = {
  apiVersion: 'playlist.grafana.app/v1',
  kind: 'Playlist',
  spec: {
    title: 'The display',
    interval: '5m',
    items: [{ type: 'dashboard_by_uid', value: 'aaa' }],
  },
  metadata: {
    name: 'playlist-uid',
  },
  status: {},
};

type QueryResult = ReturnType<typeof useGetPlaylistQuery>;

function mockQuery(result: Partial<QueryResult>) {
  jest.mocked(useGetPlaylistQuery).mockReturnValue({
    isLoading: false,
    isError: false,
    ...result,
  } as QueryResult);
}

describe('PlaylistStartPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(playlistSrv.start).mockResolvedValue({ started: true });
  });

  it('reports that the playlist is loading instead of rendering nothing', () => {
    mockQuery({ isLoading: true });

    render(<PlaylistStartPage />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(playlistSrv.start).not.toHaveBeenCalled();
  });

  it('reports that the playlist is starting while it starts', async () => {
    mockQuery({ data: playlist });
    // A start that has not resolved yet: the page is what the viewer looks at until the first
    // dashboard replaces it.
    jest.mocked(playlistSrv.start).mockReturnValue(new Promise(() => {}));

    render(<PlaylistStartPage />);

    expect(await screen.findByText('Starting playlist...')).toBeInTheDocument();
    expect(playlistSrv.start).toHaveBeenCalledWith(playlist);
  });

  it('starts the playlist exactly once for one loaded playlist', async () => {
    mockQuery({ data: playlist });

    const { rerender } = render(<PlaylistStartPage />);
    rerender(<PlaylistStartPage />);

    await waitFor(() => expect(playlistSrv.start).toHaveBeenCalledTimes(1));
  });

  it('names an empty playlist as the cause and offers the editor and the list', async () => {
    mockQuery({ data: playlist });
    jest.mocked(playlistSrv.start).mockResolvedValue({ started: false, failureReason: 'no-items' });

    render(<PlaylistStartPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('This playlist is empty');
    expect(screen.getByText(/no dashboards to play/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit playlist' })).toHaveAttribute('href', '/playlists/edit/playlist-uid');
    expect(screen.getByRole('link', { name: 'Back to playlists' })).toHaveAttribute('href', '/playlists');

    // These two are the whole of the page's recovery affordance, and a `size="md"` button is 12 px
    // short of a 44 px target.
    for (const action of screen.getAllByRole('link')) {
      expect(window.getComputedStyle(action)).toMatchObject({ minWidth: '44px', minHeight: '44px' });
    }
  });

  it('names unresolvable dashboards as the cause and offers the editor and the list', async () => {
    mockQuery({ data: playlist });
    jest.mocked(playlistSrv.start).mockResolvedValue({ started: false, failureReason: 'no-dashboards' });

    render(<PlaylistStartPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('No dashboards could be found for this playlist');
    expect(screen.getByText(/may have been deleted/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit playlist' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to playlists' })).toBeInTheDocument();
  });

  it('reports a start that failed outright', async () => {
    mockQuery({ data: playlist });
    jest.mocked(playlistSrv.start).mockRejectedValue(new Error('dashboard search is unreachable'));

    render(<PlaylistStartPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('This playlist could not be started');
    expect(screen.getByRole('link', { name: 'Back to playlists' })).toBeInTheDocument();
  });

  it('reports a playlist that could not be loaded, without offering an editor for it', async () => {
    mockQuery({ isError: true });

    render(<PlaylistStartPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('This playlist could not be loaded');
    expect(screen.queryByRole('link', { name: 'Edit playlist' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to playlists' })).toBeInTheDocument();
    expect(playlistSrv.start).not.toHaveBeenCalled();
  });
});
