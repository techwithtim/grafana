import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { from, of, throwError } from 'rxjs';
import { TestProvider } from 'test/helpers/TestProvider';

import { locationService } from '@grafana/runtime';
import { setTestFlags } from '@grafana/test-utils/unstable';
import { contextSrv } from 'app/core/services/context_srv';
import { AccessControlAction } from 'app/types/accessControl';

import { createFetchResponse } from '../../../test/helpers/createFetchResponse';
import { PLAYLIST_LIST_MAX_PAGES } from '../../api/clients/playlist/v1';
import { backendSrv } from '../../core/services/backend_srv';

import { PlaylistPage } from './PlaylistPage';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => backendSrv,
}));

jest.mock('app/core/services/context_srv', () => ({
  contextSrv: {
    ...jest.requireActual('app/core/services/context_srv').contextSrv,
    hasPermission: jest.fn(),
    isEditor: false,
  },
}));

function setup() {
  return render(
    <TestProvider>
      <PlaylistPage />
    </TestProvider>
  );
}

describe('PlaylistPage', () => {
  beforeEach(() => {
    jest.spyOn(backendSrv, 'fetch').mockImplementation(() => of(createFetchResponse({})));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.mocked(contextSrv.hasPermission).mockReturnValue(false);
    (contextSrv as jest.Mocked<typeof contextSrv>).isEditor = false;
    setTestFlags({ playlistsRBAC: false });
  });

  afterEach(async () => {
    // Wrap in act() — setTestFlags fires OpenFeature events that trigger state updates
    // while the previous test's component is still mounted (RTL cleanup runs afterward).
    await act(async () => {
      setTestFlags({});
    });
  });

  describe('when mounted without a playlist', () => {
    it('page should load', () => {
      setup();
      expect(screen.getByTestId('playlist-page-list-skeleton')).toBeInTheDocument();
    });

    it('then show empty list', async () => {
      setup();
      expect(await screen.findByText('There are no playlists created yet')).toBeInTheDocument();
    });

    describe('with playlistsRBAC toggle on', () => {
      beforeEach(() => {
        setTestFlags({ playlistsRBAC: true });
      });

      describe('and user has playlists:write', () => {
        it('then create playlist button should not be disabled', async () => {
          jest
            .mocked(contextSrv.hasPermission)
            .mockImplementation((action) => action === AccessControlAction.PlaylistsWrite);
          setup();
          const createPlaylistButton = await screen.findByRole('link', { name: /create playlist/i });
          expect(createPlaylistButton).not.toHaveStyle('pointer-events: none');
        });
      });

      describe('and user does not have playlists:write (isEditor is ignored)', () => {
        it('then create playlist button should be disabled', async () => {
          jest.mocked(contextSrv.hasPermission).mockReturnValue(false);
          (contextSrv as jest.Mocked<typeof contextSrv>).isEditor = true;
          setup();
          const createPlaylistButton = await screen.findByRole('link', { name: /create playlist/i });
          expect(createPlaylistButton).toHaveStyle('pointer-events: none');
        });
      });
    });

    describe('with playlistsRBAC toggle off (legacy)', () => {
      describe('and user is an editor', () => {
        it('then create playlist button should not be disabled', async () => {
          (contextSrv as jest.Mocked<typeof contextSrv>).isEditor = true;
          setup();
          const createPlaylistButton = await screen.findByRole('link', { name: /create playlist/i });
          expect(createPlaylistButton).not.toHaveStyle('pointer-events: none');
        });
      });

      describe('and user is not an editor', () => {
        it('then create playlist button should be disabled', async () => {
          setup();
          const createPlaylistButton = await screen.findByRole('link', { name: /create playlist/i });
          expect(createPlaylistButton).toHaveStyle('pointer-events: none');
        });
      });
    });
  });

  describe('when mounted with a playlist', () => {
    beforeEach(() => {
      jest.spyOn(backendSrv, 'fetch').mockImplementation(() =>
        of(
          createFetchResponse({
            items: [
              {
                spec: {
                  title: 'A test playlist',
                  interval: '10m',
                  items: [
                    { title: 'First item', type: 'dashboard_by_uid', value: '1' },
                    { title: 'Middle item', type: 'dashboard_by_uid', value: '2' },
                    { title: 'Last item', type: 'dashboard_by_tag', value: 'Last item' },
                  ],
                },
                metadata: {
                  name: 0,
                  uid: 'playlist-0',
                },
              },
            ],
          })
        )
      );
    });

    it('page should load', () => {
      setup();
      expect(screen.getByTestId('playlist-page-list-skeleton')).toBeInTheDocument();
    });

    describe('with playlistsRBAC toggle on', () => {
      beforeEach(() => {
        setTestFlags({ playlistsRBAC: true });
      });

      describe('and user has playlists:write', () => {
        it('then all playlist buttons should appear', async () => {
          jest
            .mocked(contextSrv.hasPermission)
            .mockImplementation((action) => action === AccessControlAction.PlaylistsWrite);
          setup();
          expect(await screen.findByText('A test playlist'));
          expect(await screen.findByRole('link', { name: /New playlist/i })).toBeInTheDocument();
          expect(await screen.findByRole('button', { name: /Start playlist/i })).toBeInTheDocument();
          expect(await screen.findByRole('link', { name: /Edit playlist/i })).toBeInTheDocument();
          expect(await screen.findByRole('button', { name: /Delete playlist/i })).toBeInTheDocument();
        });
      });

      describe('and user does not have playlists:write (isEditor is ignored)', () => {
        it('then only start playlist button should appear', async () => {
          jest.mocked(contextSrv.hasPermission).mockReturnValue(false);
          (contextSrv as jest.Mocked<typeof contextSrv>).isEditor = true;
          setup();
          expect(await screen.findByText('A test playlist')).toBeInTheDocument();
          expect(screen.queryByRole('link', { name: /New playlist/i })).not.toBeInTheDocument();
          expect(await screen.findByRole('button', { name: /Start playlist/i })).toBeInTheDocument();
          expect(screen.queryByRole('link', { name: /Edit playlist/i })).not.toBeInTheDocument();
          expect(screen.queryByRole('button', { name: /Delete playlist/i })).not.toBeInTheDocument();
        });
      });
    });

    describe('with playlistsRBAC toggle off (legacy)', () => {
      describe('and user is an editor', () => {
        it('then all playlist buttons should appear', async () => {
          jest.mocked(contextSrv.hasPermission).mockReturnValue(false);
          (contextSrv as jest.Mocked<typeof contextSrv>).isEditor = true;
          setup();
          expect(await screen.findByText('A test playlist'));
          expect(await screen.findByRole('link', { name: /New playlist/i })).toBeInTheDocument();
          expect(await screen.findByRole('button', { name: /Start playlist/i })).toBeInTheDocument();
          expect(await screen.findByRole('link', { name: /Edit playlist/i })).toBeInTheDocument();
          expect(await screen.findByRole('button', { name: /Delete playlist/i })).toBeInTheDocument();
        });
      });

      describe('and user is not an editor', () => {
        it('then only start playlist button should appear', async () => {
          setup();
          expect(await screen.findByText('A test playlist')).toBeInTheDocument();
          expect(screen.queryByRole('link', { name: /New playlist/i })).not.toBeInTheDocument();
          expect(await screen.findByRole('button', { name: /Start playlist/i })).toBeInTheDocument();
          expect(screen.queryByRole('link', { name: /Edit playlist/i })).not.toBeInTheDocument();
          expect(screen.queryByRole('button', { name: /Delete playlist/i })).not.toBeInTheDocument();
        });
      });
    });
  });

  // The apiserver returns a list in chunks once the response outgrows its size budget and hands
  // back a continue token for the rest, which a single oversized playlist is enough to trigger.
  // The page used to render the first chunk as if it were the whole namespace: the playlists in
  // the later chunks had no card, and searching for one of them answered "No playlists found".
  describe('when the apiserver returns the list in chunks', () => {
    interface ListPage {
      titles: string[];
      /** The token this page hands back; absent on the last page of the namespace. */
      continueToken?: string;
    }

    /**
     * Answers the list request, and each continuation, with the next page — keyed on the continue
     * token the request carried, so the recorded tokens prove which requests the page actually
     * made rather than only how many.
     */
    function mockChunkedList(pages: ListPage[]) {
      const listRequests: Array<string | undefined> = [];

      jest.spyOn(backendSrv, 'fetch').mockImplementation((options) => {
        if (!options.url.endsWith('/playlists')) {
          return of(createFetchResponse({}));
        }

        const token: string | undefined = options.params?.continue;
        listRequests.push(token);

        const pageIndex = token === undefined ? 0 : pages.findIndex((page) => page.continueToken === token) + 1;
        if (token !== undefined && pageIndex === 0) {
          throw new Error(`continuation asked for an unknown token: ${token}`);
        }
        const page = pages[pageIndex];

        return of(
          createFetchResponse({
            items: page.titles.map((title) => ({
              spec: { title, interval: '10m', items: [] },
              metadata: { name: title.replace(/\s/g, '-').toLowerCase(), uid: `uid-${title}` },
            })),
            metadata: page.continueToken ? { continue: page.continueToken } : {},
          })
        );
      });

      return listRequests;
    }

    /** Answers every list request with one playlist and a fresh token, so the namespace never ends. */
    function mockEndlessList() {
      const listRequests: Array<string | undefined> = [];

      jest.spyOn(backendSrv, 'fetch').mockImplementation((options) => {
        if (!options.url.endsWith('/playlists')) {
          return of(createFetchResponse({}));
        }

        const served = listRequests.length;
        listRequests.push(options.params?.continue);

        return of(
          createFetchResponse({
            items: [
              {
                spec: { title: `Endless playlist ${served}`, interval: '10m', items: [] },
                metadata: { name: `endless-${served}`, uid: `uid-endless-${served}` },
              },
            ],
            metadata: { continue: `tok-${served}` },
          })
        );
      });

      return listRequests;
    }

    beforeEach(() => {
      (contextSrv as jest.Mocked<typeof contextSrv>).isEditor = true;
    });

    it('follows the continue tokens and renders every playlist in the namespace', async () => {
      const listRequests = mockChunkedList([
        { titles: ['First chunk A', 'First chunk B'], continueToken: 'tok-1' },
        { titles: ['Second chunk A'], continueToken: 'tok-2' },
        { titles: ['Last chunk playlist'] },
      ]);
      setup();

      expect(await screen.findByText('Last chunk playlist')).toBeInTheDocument();
      expect(screen.getByText('First chunk A')).toBeInTheDocument();
      expect(screen.getByText('First chunk B')).toBeInTheDocument();
      expect(screen.getByText('Second chunk A')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /start playlist/i })).toHaveLength(4);
      // Each continuation carries the token the previous page handed back.
      expect(listRequests).toEqual([undefined, 'tok-1', 'tok-2']);
      expect(screen.queryByText('Not all playlists are shown')).not.toBeInTheDocument();
    });

    it('finds a playlist that only a later chunk contains', async () => {
      mockChunkedList([{ titles: ['First chunk A'], continueToken: 'tok-1' }, { titles: ['Last chunk playlist'] }]);
      const user = userEvent.setup();
      setup();

      expect(await screen.findByText('Last chunk playlist')).toBeInTheDocument();
      await user.type(screen.getByPlaceholderText('Search by name or type'), 'Last chunk');

      expect(await screen.findByText('Last chunk playlist')).toBeInTheDocument();
      expect(screen.queryByText('First chunk A')).not.toBeInTheDocument();
      expect(screen.queryByText('No playlists found')).not.toBeInTheDocument();
    });

    it('says the list is incomplete when the namespace outlasts the page budget', async () => {
      const listRequests = mockEndlessList();
      setup();

      expect(await screen.findByText('Not all playlists are shown')).toBeInTheDocument();
      expect(listRequests).toHaveLength(PLAYLIST_LIST_MAX_PAGES);
      expect(
        screen.getByText(
          `This list is too large to load completely, so it shows the first ${PLAYLIST_LIST_MAX_PAGES} playlists. ` +
            'Playlists it leaves out are missing from the search results as well.'
        )
      ).toBeInTheDocument();
    });

    it('keeps saying the list is incomplete when a search matches none of the playlists it loaded', async () => {
      mockEndlessList();
      const user = userEvent.setup();
      setup();

      expect(await screen.findByText('Not all playlists are shown')).toBeInTheDocument();
      await user.type(screen.getByPlaceholderText('Search by name or type'), 'a playlist in the missing tail');

      expect(await screen.findByText('No playlists found')).toBeInTheDocument();
      // Without this, "No playlists found" claims the playlist does not exist.
      expect(screen.getByText('Not all playlists are shown')).toBeInTheDocument();
    });

    it('shows the playlists it loaded and says the list is incomplete when a continuation fails', async () => {
      const listRequests: Array<string | undefined> = [];
      jest.spyOn(backendSrv, 'fetch').mockImplementation((options) => {
        if (!options.url.endsWith('/playlists')) {
          return of(createFetchResponse({}));
        }
        const token: string | undefined = options.params?.continue;
        listRequests.push(token);
        if (token) {
          return throwError(() => ({ status: 500, data: { message: 'list failed' } }));
        }
        return of(
          createFetchResponse({
            items: [
              {
                spec: { title: 'Loaded before the failure', interval: '10m', items: [] },
                metadata: { name: 'loaded-playlist', uid: 'uid-loaded' },
              },
            ],
            metadata: { continue: 'tok-1' },
          })
        );
      });
      setup();

      expect(await screen.findByText('Loaded before the failure')).toBeInTheDocument();
      expect(await screen.findByText('Not all playlists are shown')).toBeInTheDocument();
      expect(listRequests).toEqual([undefined, 'tok-1']);
    });

    it('makes exactly one request and shows no notice when the whole namespace fits in one chunk', async () => {
      const listRequests = mockChunkedList([{ titles: ['Only playlist'] }]);
      setup();

      expect(await screen.findByText('Only playlist')).toBeInTheDocument();
      expect(listRequests).toEqual([undefined]);
      expect(screen.queryByText('Not all playlists are shown')).not.toBeInTheDocument();
    });
  });

  describe('focus after the delete confirmation dialog closes', () => {
    interface SeededPlaylist {
      name: string;
      title: string;
    }

    /**
     * Answers the list GET with the seeded playlists, the DELETE with an empty body, and every
     * request made after a deletion with the playlists that survive it — which is what the
     * refetch triggered by the invalidated `Playlist` tag picks up.
     *
     * With `deferRefetch`, that post-deletion response is held back until the returned
     * `releaseRefetch` is called, so a test can interact with the page while the deleted card is
     * still on screen.
     */
    function mockPlaylistBackend(seeded: SeededPlaylist[], { deferRefetch = false } = {}) {
      const deleted = new Set<string>();
      let releaseRefetch: (() => void) | undefined;
      const refetchGate = new Promise<void>((resolve) => {
        releaseRefetch = resolve;
      });

      const listResponse = () =>
        createFetchResponse({
          items: seeded
            .filter(({ name }) => !deleted.has(name))
            .map(({ name, title }) => ({
              spec: { title, interval: '10m', items: [] },
              metadata: { name, uid: `uid-${name}` },
            })),
        });

      jest.spyOn(backendSrv, 'fetch').mockImplementation((options) => {
        if (options.method === 'DELETE') {
          deleted.add(options.url.split('/').pop() ?? '');
          return of(createFetchResponse({}));
        }
        if (deferRefetch && deleted.size > 0) {
          return from(refetchGate.then(() => listResponse()));
        }
        return of(listResponse());
      });

      return { releaseRefetch: () => releaseRefetch?.() };
    }

    /** Focuses the first card's "Delete playlist" button and opens the confirmation dialog. */
    async function openDeleteDialog(user: UserEvent) {
      const [deleteButton] = await screen.findAllByRole('button', { name: /delete playlist/i });
      deleteButton.focus();
      await user.click(deleteButton);
      return { deleteButton, dialog: await screen.findByRole('dialog') };
    }

    beforeEach(() => {
      // Legacy (playlistsRBAC off) write access, so the cards render "Delete playlist" and the
      // page renders its "New playlist" action.
      (contextSrv as jest.Mocked<typeof contextSrv>).isEditor = true;
    });

    it('moves focus to the "New playlist" link when the confirmed deletion unmounts the card', async () => {
      mockPlaylistBackend([
        { name: 'playlist-a', title: 'Playlist A' },
        { name: 'playlist-b', title: 'Playlist B' },
      ]);
      const user = userEvent.setup();
      setup();

      const { dialog } = await openDeleteDialog(user);
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(screen.queryByText('Playlist A')).not.toBeInTheDocument());
      expect(screen.getByText('Playlist B')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /new playlist/i })).toHaveFocus();
      expect(document.body).not.toHaveFocus();
    });

    it('moves focus to the empty-state "Create playlist" link when the last playlist is deleted', async () => {
      mockPlaylistBackend([{ name: 'playlist-a', title: 'Playlist A' }]);
      const user = userEvent.setup();
      setup();

      const { dialog } = await openDeleteDialog(user);
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      expect(await screen.findByText('There are no playlists created yet')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /create playlist/i })).toHaveFocus();
      expect(document.body).not.toHaveFocus();
    });

    it('returns focus to the "Delete playlist" button when the dialog is cancelled', async () => {
      mockPlaylistBackend([
        { name: 'playlist-a', title: 'Playlist A' },
        { name: 'playlist-b', title: 'Playlist B' },
      ]);
      const user = userEvent.setup();
      setup();

      const { deleteButton, dialog } = await openDeleteDialog(user);
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByText('Playlist A')).toBeInTheDocument();
      expect(deleteButton).toHaveFocus();
    });

    it('returns focus to the "Delete playlist" button when the dialog is dismissed with Escape', async () => {
      mockPlaylistBackend([
        { name: 'playlist-a', title: 'Playlist A' },
        { name: 'playlist-b', title: 'Playlist B' },
      ]);
      const user = userEvent.setup();
      setup();

      const { deleteButton } = await openDeleteDialog(user);
      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(deleteButton).toHaveFocus();
    });

    it('leaves focus alone when the user moved it elsewhere before the deleted card unmounted', async () => {
      const { releaseRefetch } = mockPlaylistBackend(
        [
          { name: 'playlist-a', title: 'Playlist A' },
          { name: 'playlist-b', title: 'Playlist B' },
        ],
        { deferRefetch: true }
      );
      const user = userEvent.setup();
      setup();

      const { dialog } = await openDeleteDialog(user);
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      // The deletion is through but its refetch has not landed, so the card — and the user's own
      // choice of where to put focus — are both still there.
      const searchInput = screen.getByPlaceholderText('Search by name or type');
      await user.click(searchInput);
      expect(searchInput).toHaveFocus();

      await act(async () => {
        releaseRefetch();
      });

      await waitFor(() => expect(screen.queryByText('Playlist A')).not.toBeInTheDocument());
      expect(searchInput).toHaveFocus();
    });
  });

  describe('pull request banner', () => {
    afterEach(() => {
      locationService.push('/playlists');
    });

    it('does not show the banner without pull-request params', async () => {
      locationService.push('/playlists');
      setup();

      expect(await screen.findByText('There are no playlists created yet')).toBeInTheDocument();
      expect(screen.queryByText(/open pull request/i)).not.toBeInTheDocument();
    });

    it('shows the PR banner with source and target branches when redirected with PR params', async () => {
      locationService.push(
        '/playlists?new_pull_request_url=https%3A%2F%2Fgithub.com%2Forg%2Frepo%2Fpull%2F1' +
          '&repo_type=github&action=create&ref=feature-branch&repo_branch=main&repo_url=https%3A%2F%2Fgithub.com%2Forg%2Frepo'
      );
      setup();

      // The banner offers to open the pull request...
      expect(await screen.findByText(/open pull request/i)).toBeInTheDocument();
      // ...and shows the source and target branches.
      expect(await screen.findByRole('link', { name: 'feature-branch' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'main' })).toBeInTheDocument();
    });
  });
});
