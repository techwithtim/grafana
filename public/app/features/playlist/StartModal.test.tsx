import { render, screen } from 'test/test-utils';

import { config, locationService } from '@grafana/runtime';

import { type Playlist } from '../../api/clients/playlist/v1';

import { StartModal } from './StartModal';

jest.mock('@grafana/runtime', () => {
  const actual = jest.requireActual('@grafana/runtime');
  return {
    ...actual,
    locationService: {
      ...actual.locationService,
      push: jest.fn(),
      getHistory: () => actual.locationService,
    },
    reportInteraction: jest.fn(),
  };
});

const mockPlaylist: Playlist = {
  apiVersion: 'playlist.grafana.app/v1',
  kind: 'Playlist',
  spec: {
    title: 'Test playlist',
    interval: '5m',
    items: [],
  },
  metadata: {
    name: 'test-playlist-uid',
  },
  status: {},
};

function setup() {
  return render(<StartModal playlist={mockPlaylist} onDismiss={jest.fn()} />);
}

describe('StartModal', () => {
  let originalDashboardNewLayouts: boolean | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    // The "Navigation buttons" option only renders behind this toggle, so it is enabled for the whole suite.
    originalDashboardNewLayouts = config.featureToggles.dashboardNewLayouts;
    config.featureToggles.dashboardNewLayouts = true;
  });

  afterEach(() => {
    config.featureToggles.dashboardNewLayouts = originalDashboardNewLayouts;
  });

  describe('Hide logo checkbox', () => {
    it('is not visible in Normal mode', () => {
      setup();
      expect(screen.queryByRole('checkbox', { name: /hide logo/i })).not.toBeInTheDocument();
    });

    it('becomes visible when Kiosk mode is selected', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));
      expect(screen.getByRole('checkbox', { name: /hide logo/i })).toBeInTheDocument();
    });

    it('is hidden again when switching back to Normal mode', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));
      await user.click(screen.getByRole('radio', { name: /normal/i }));
      expect(screen.queryByRole('checkbox', { name: /hide logo/i })).not.toBeInTheDocument();
    });
  });

  describe('Kiosk mode note', () => {
    it('is not shown in Normal mode', () => {
      setup();
      expect(screen.queryByText(/kiosk mode hides the playlist controls/i)).not.toBeInTheDocument();
    });

    it('appears when Kiosk mode is selected and names the Esc key', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));

      const note = screen.getByText(/kiosk mode hides the playlist controls/i);
      expect(note).toBeInTheDocument();
      expect(note).toHaveTextContent(/esc/i);
      expect(note).toHaveTextContent(/stop playlist/i);
    });

    it('is hidden again when switching back to Normal mode', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));
      expect(screen.getByText(/kiosk mode hides the playlist controls/i)).toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: /normal/i }));
      expect(screen.queryByText(/kiosk mode hides the playlist controls/i)).not.toBeInTheDocument();
    });

    it('leaves the Navigation buttons option available and enabled in kiosk mode', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));

      const navigationButtons = screen.getByRole('checkbox', { name: /navigation buttons/i });
      expect(navigationButtons).toBeInTheDocument();
      expect(navigationButtons).toBeEnabled();
      expect(navigationButtons).toBeChecked();
    });
  });

  describe('Variables checkbox', () => {
    it('explains that clearing it hides the per-item variable values', () => {
      setup();
      expect(
        screen.getByText(/applies template variable values per dashboard and displays them in these controls/i)
      ).toBeInTheDocument();
    });

    it('is checked by default and can be toggled', async () => {
      const { user } = setup();
      const variables = screen.getByRole('checkbox', { name: /^variables/i });
      expect(variables).toBeEnabled();
      expect(variables).toBeChecked();

      await user.click(variables);
      expect(variables).not.toBeChecked();
    });
  });

  describe('when starting the playlist', () => {
    it('includes hideLogo=1 in the URL when Hide logo is checked in kiosk mode', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));
      await user.click(screen.getByRole('checkbox', { name: /hide logo/i }));
      await user.click(screen.getByRole('button', { name: /start/i }));
      expect(locationService.push).toHaveBeenCalledWith(expect.stringContaining('hideLogo=1'));
    });

    it('does not include hideLogo in the URL when Hide logo is not checked', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));
      await user.click(screen.getByRole('button', { name: /start/i }));
      expect(locationService.push).toHaveBeenCalledWith(expect.not.stringContaining('hideLogo'));
    });

    it('includes _dash.hideVariables in the URL when Variables is cleared', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('checkbox', { name: /^variables/i }));
      await user.click(screen.getByRole('button', { name: /start/i }));
      expect(locationService.push).toHaveBeenCalledWith(expect.stringContaining('_dash.hideVariables'));
    });

    it('does not include _dash.hideVariables in the URL when Variables is left checked', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('button', { name: /start/i }));
      expect(locationService.push).toHaveBeenCalledWith(expect.not.stringContaining('_dash.hideVariables'));
    });
  });
});
