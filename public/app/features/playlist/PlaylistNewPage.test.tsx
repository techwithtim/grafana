import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { of, Subject, throwError } from 'rxjs';
import { TestProvider } from 'test/helpers/TestProvider';

import { type FetchResponse, locationService } from '@grafana/runtime';
import { type DashboardPickerDTO } from 'app/core/components/Select/DashboardPicker';

import { createFetchResponse } from '../../../test/helpers/createFetchResponse';
import { backendSrv } from '../../core/services/backend_srv';
import { useResourceRepositorySelection } from '../provisioning/hooks/useResourceRepositorySelection';

import { PlaylistNewPage } from './PlaylistNewPage';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => backendSrv,
}));

jest.mock('../provisioning/hooks/useResourceRepositorySelection');

jest.mock('app/core/components/TagFilter/TagFilter', () => ({
  TagFilter: () => {
    return <>mocked-tag-filter</>;
  },
}));

// The real picker is an async Select backed by dashboard search. A button standing in for it keeps
// "add this dashboard" a single click, and `type="button"` matters: a submit button inside the
// form's real <form> would save the playlist instead of adding an item.
jest.mock('app/core/components/Select/DashboardPicker', () => ({
  DashboardPicker: ({ onChange }: { onChange: (dashboard: DashboardPickerDTO) => void }) => (
    <button
      type="button"
      onClick={() => onChange({ uid: 'uid_1', name: 'Host dashboard', folderUid: 'folder_1', folderTitle: 'Folder 1' })}
    >
      mocked-dashboard-picker
    </button>
  ),
}));

const mockUseResourceRepositorySelection = useResourceRepositorySelection as jest.MockedFunction<
  typeof useResourceRepositorySelection
>;

/**
 * How each POST behaves, consumed one entry per request in order; any request beyond the list
 * succeeds. `'fail'` rejects it the way the backend does, and a `Subject` hands the test control of
 * when the response arrives, which is how "the page waits for it" is asserted without racing it.
 */
type PostOutcome = 'ok' | 'fail' | Subject<FetchResponse<unknown>>;

/**
 * The shape `createBaseQuery` hands to RTK Query when a playlist write fails: a Grafana
 * `FetchError` carrying the apiserver's `Status` body and the request `config`. Built to match a
 * real failure so the tests exercise the same path the browser does.
 */
function createFailure() {
  return {
    status: 500,
    statusText: 'Internal Server Error',
    data: {
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Failure',
      message: 'simulated backend failure',
      reason: 'InternalError',
      code: 500,
    },
    config: {
      url: '/apis/playlist.grafana.app/v1/namespaces/default/playlists',
      method: 'POST',
    },
  };
}

function getTestContext(
  provisioning: ReturnType<typeof useResourceRepositorySelection> = { isAvailable: false, repositories: [] },
  postOutcomes: PostOutcome[] = []
) {
  jest.clearAllMocks();
  // Provisioning unavailable by default, so the repository selector is hidden.
  mockUseResourceRepositorySelection.mockReturnValue(provisioning);

  // Create separate spies for different HTTP methods
  const postSpy = jest.fn();
  const otherSpy = jest.fn();

  const backendSrvMock = jest.spyOn(backendSrv, 'fetch').mockImplementation((options) => {
    if (options.method === 'POST') {
      postSpy(options);
      const outcome = postOutcomes[postSpy.mock.calls.length - 1] ?? 'ok';
      if (outcome === 'fail') {
        return throwError(createFailure);
      }
      if (outcome !== 'ok') {
        return outcome;
      }
      return of(createFetchResponse({}));
    }
    // Handle GET and other methods
    otherSpy(options);
    return of(createFetchResponse({ items: [] }));
  });

  jest.spyOn(backendSrv, 'search').mockResolvedValue([]);

  const { rerender } = render(
    <TestProvider>
      <PlaylistNewPage />
    </TestProvider>
  );

  return { rerender, backendSrvMock, postSpy, otherSpy };
}

describe('PlaylistNewPage', () => {
  describe('when mounted', () => {
    it('then header should be correct', async () => {
      getTestContext();

      expect(await screen.findByRole('heading', { name: /new playlist/i })).toBeInTheDocument();
    });
  });

  describe('when submitted', () => {
    it('then correct api should be called', async () => {
      const { postSpy } = getTestContext();

      expect(locationService.getLocation().pathname).toEqual('/');

      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'A new name');
      await userEvent.clear(screen.getByRole('textbox', { name: 'Interval' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Interval' }), '10m');
      // A playlist with no items cannot be saved — Save presents as unavailable and the submit
      // refuses it — so the reachable path adds a dashboard first.
      await userEvent.click(await screen.findByRole('button', { name: 'mocked-dashboard-picker' }));
      await userEvent.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));

      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            spec: {
              title: 'A new name',
              interval: '10m',
              items: [{ type: 'dashboard_by_uid', value: 'uid_1' }],
            },
          }),
        })
      );
      await waitFor(() => {
        expect(locationService.getLocation().pathname).toEqual('/playlists');
      });
    });

    it('then it should not navigate until the create has been stored', async () => {
      // The playlist list is a cached query that `createPlaylist` invalidates, so navigating
      // before the response arrived left the list rendering its pre-create contents until a manual
      // reload. Holding the response open proves the navigation waits for it.
      locationService.push('/playlists/new');
      const post = new Subject<FetchResponse<unknown>>();
      const { postSpy } = getTestContext(undefined, [post]);

      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'An awaited name');
      await userEvent.click(await screen.findByRole('button', { name: 'mocked-dashboard-picker' }));
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
      expect(locationService.getLocation().pathname).toEqual('/playlists/new');

      await act(async () => {
        post.next(createFetchResponse({}));
        post.complete();
      });

      await waitFor(() => expect(locationService.getLocation().pathname).toEqual('/playlists'));
    });
  });

  describe('when the create fails', () => {
    it('then it should stay on the form with every unsaved value intact', async () => {
      locationService.push('/playlists/new');
      const { postSpy } = getTestContext(undefined, ['fail']);

      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'A new name');
      await userEvent.click(await screen.findByRole('button', { name: 'mocked-dashboard-picker' }));
      await userEvent.click(screen.getByRole('button', { name: 'Template variables' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Variable name' }), 'host');
      await userEvent.type(screen.getByRole('textbox', { name: 'Values (comma-separated)' }), 'Fail1');
      await userEvent.click(screen.getByRole('button', { name: 'Add variable' }));

      await userEvent.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));

      // The failed create must not navigate: the form is still mounted and still holds the name,
      // the added row and the committed variable, so nothing has to be entered again.
      expect(locationService.getLocation().pathname).toEqual('/playlists/new');
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('A new name');
      // The added row is a `listitem` of the item list, and its committed variable fields are
      // named after the variable and the row's position in that list.
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
      expect(screen.getByRole('textbox', { name: 'Variable name for host, item 1' })).toHaveValue('host');
      expect(screen.getByRole('textbox', { name: 'Values for host, item 1' })).toHaveValue('Fail1');
    });

    it('then Save should be usable again and a second click should retry the create', async () => {
      locationService.push('/playlists/new');
      const { postSpy } = getTestContext(undefined, ['fail']);

      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'A retried name');
      await userEvent.click(await screen.findByRole('button', { name: 'mocked-dashboard-picker' }));
      await userEvent.click(screen.getByRole('button', { name: 'Template variables' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Variable name' }), 'host');
      await userEvent.type(screen.getByRole('textbox', { name: 'Values (comma-separated)' }), 'Retry1');
      await userEvent.click(screen.getByRole('button', { name: 'Add variable' }));

      await userEvent.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));

      // Recovery is one click: the failure left the form in place, and `PlaylistForm.doSubmit`
      // clears `saving` in its `finally`, so the second POST is a retry of the same payload rather
      // than a re-entered one, and it succeeds.
      expect(locationService.getLocation().pathname).toEqual('/playlists/new');
      await waitFor(() => expect(screen.getByRole('button', { name: /save/i })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2));

      const expectedBody = expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          spec: {
            title: 'A retried name',
            interval: '5m',
            items: [{ type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Retry1'] } }],
          },
        }),
      });
      expect(postSpy).toHaveBeenNthCalledWith(1, expectedBody);
      expect(postSpy).toHaveBeenNthCalledWith(2, expectedBody);
      await waitFor(() => expect(locationService.getLocation().pathname).toEqual('/playlists'));
    });
  });

  describe('repository selector', () => {
    const repositories = [
      { name: 'test-repo', title: 'Test Repository', target: 'instance' as const, type: 'git' as const, workflows: [] },
    ];

    it('is not shown when provisioning is unavailable', async () => {
      getTestContext();

      expect(await screen.findByRole('heading', { name: /new playlist/i })).toBeInTheDocument();
      expect(screen.queryByText('Repository')).not.toBeInTheDocument();
    });

    it('is shown when provisioning is available', async () => {
      getTestContext({ isAvailable: true, repositories });

      expect(await screen.findByText('Repository')).toBeInTheDocument();
    });

    it('is not shown when no repositories are configured', async () => {
      // The hook reports isAvailable=false when there are no repositories, so the selector is hidden.
      getTestContext({ isAvailable: false, repositories: [] });

      expect(await screen.findByRole('heading', { name: /new playlist/i })).toBeInTheDocument();
      expect(screen.queryByText('Repository')).not.toBeInTheDocument();
    });

    it('opens the provisioning save drawer instead of creating directly once a repository is selected', async () => {
      const { postSpy } = getTestContext({ isAvailable: true, repositories });

      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Repo Playlist');
      // An item-less playlist is refused before either save path is chosen, so add a dashboard
      // first — the drawer-versus-direct-create decision is what this case is about.
      await userEvent.click(await screen.findByRole('button', { name: 'mocked-dashboard-picker' }));
      // Select the (only) repository. No selection = stored in Grafana (a cleared placeholder, not a
      // literal row), so ArrowDown highlights the first repo. Options are virtualized in jsdom and
      // not reliably queryable, but downshift still tracks the highlighted index.
      const combobox = await screen.findByRole('combobox', { name: /repository/i });
      await userEvent.click(combobox);
      await userEvent.keyboard('{ArrowDown}{Enter}');

      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      // The provisioning save drawer opens...
      expect(await screen.findByRole('heading', { name: /save provisioned playlist/i })).toBeInTheDocument();
      // ...and the playlist is not created directly through the playlist API.
      expect(postSpy).not.toHaveBeenCalled();
    });
  });
});
