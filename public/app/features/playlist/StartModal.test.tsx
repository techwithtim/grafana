import { act } from '@testing-library/react';
import axe from 'axe-core';
import { render, screen } from 'test/test-utils';

import { selectors } from '@grafana/e2e-selectors';
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

/**
 * Every checkbox must own a unique id and be named by exactly one label. `Checkbox` falls back to
 * the id published by its surrounding `Field`, so a group of checkboxes sharing one `Field` used to
 * render the same id three times and let that Field's label attach to the first of them.
 */
function expectUniqueIdsAndOneLabelEach() {
  const checkboxes = screen.getAllByRole('checkbox');
  expect(checkboxes.length).toBeGreaterThan(0);

  const ids = checkboxes.map((checkbox) => checkbox.id);
  for (const id of ids) {
    expect(id).not.toBe('');
  }
  expect(new Set(ids)).toHaveProperty('size', ids.length);

  // Mirrors the Lighthouse duplicate-id-aria audit over the whole dialog, not just the checkboxes.
  const dialogIds = Array.from(screen.getByRole('dialog').querySelectorAll('[id]')).map((element) => element.id);
  expect(new Set(dialogIds)).toHaveProperty('size', dialogIds.length);

  const labels = Array.from(document.querySelectorAll('label'));
  for (const checkbox of checkboxes) {
    // The only label naming a checkbox is the one `Checkbox` wraps it in.
    expect(checkbox.closest('label')).not.toBeNull();
    expect(labels.filter((label) => label.getAttribute('for') === checkbox.id)).toHaveLength(0);
  }
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
  });

  describe('Navigation buttons checkbox', () => {
    it('is offered and checked in Normal mode when dashboardNewLayouts is enabled', () => {
      setup();
      const navigationButtons = screen.getByRole('checkbox', { name: /navigation buttons/i });
      expect(navigationButtons).toBeEnabled();
      expect(navigationButtons).toBeChecked();
    });

    it('is not rendered when dashboardNewLayouts is disabled', () => {
      config.featureToggles.dashboardNewLayouts = false;
      setup();
      expect(screen.queryByRole('checkbox', { name: /navigation buttons/i })).not.toBeInTheDocument();
    });

    // Kiosk removes the dashboard actions row that hosts previous/stop/next, so the option cannot
    // take effect there and must not be presented as an effective choice.
    it('is not offered while Kiosk mode is selected', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));

      expect(screen.queryByRole('checkbox', { name: /navigation buttons/i })).not.toBeInTheDocument();
      expect(screen.getByText(/kiosk mode hides the playlist controls/i)).toBeInTheDocument();
    });

    it('is not offered in Kiosk mode even when dashboardNewLayouts is disabled', async () => {
      config.featureToggles.dashboardNewLayouts = false;
      const { user } = setup();
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));

      expect(screen.queryByRole('checkbox', { name: /navigation buttons/i })).not.toBeInTheDocument();
    });

    it('comes back in the state the user left it in when switching Kiosk back to Normal', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('checkbox', { name: /navigation buttons/i }));
      expect(screen.getByRole('checkbox', { name: /navigation buttons/i })).not.toBeChecked();

      await user.click(screen.getByRole('radio', { name: /kiosk/i }));
      expect(screen.queryByRole('checkbox', { name: /navigation buttons/i })).not.toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: /normal/i }));
      const navigationButtons = screen.getByRole('checkbox', { name: /navigation buttons/i });
      expect(navigationButtons).toBeEnabled();
      expect(navigationButtons).not.toBeChecked();
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

  describe('checkbox ids and labels', () => {
    it('gives each checkbox a unique id and a single label in Normal mode', () => {
      setup();
      expect(screen.getAllByRole('checkbox')).toHaveLength(5);
      expectUniqueIdsAndOneLabelEach();
    });

    it('gives each checkbox a unique id and a single label in Kiosk mode', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));
      expect(screen.getAllByRole('checkbox')).toHaveLength(5);
      expectUniqueIdsAndOneLabelEach();
    });

    it('names the dashboard controls group with a legend instead of labelling one checkbox with it', () => {
      setup();

      const group = screen.getByRole('group', { name: /display dashboard controls/i });
      expect(group).toHaveTextContent(/customize dashboard elements visibility/i);

      for (const name of [/^time and refresh/i, /^variables/i, /^dashboard links/i]) {
        const checkbox = screen.getByRole('checkbox', { name });
        expect(group).toContainElement(checkbox);
        expect(checkbox).toHaveAccessibleName(expect.not.stringContaining('Display dashboard controls'));
      }
    });

    it('keeps the ids stable across re-renders', async () => {
      const { user } = setup();
      const before = screen.getByRole('checkbox', { name: /^time and refresh/i }).id;

      await user.click(screen.getByRole('checkbox', { name: /^time and refresh/i }));

      expect(screen.getByRole('checkbox', { name: /^time and refresh/i })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: /^time and refresh/i }).id).toBe(before);
    });
  });

  describe('the size of the modal controls', () => {
    /**
     * A checkbox's and a radio option's real hit area is the label, which both components cover with
     * an absolutely positioned input at 100% of it. A checkbox with no description was therefore one
     * line of text high and a Normal/Kiosk option 26 px, so the box is set on the label and the
     * input follows it.
     */
    it('offers every checkbox, radio option and the Start button a 44 px box', async () => {
      const { user } = setup();

      // Kiosk first, so the two options and the checkbox that only exists in kiosk are covered too.
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));

      for (const control of [...screen.getAllByRole('checkbox'), ...screen.getAllByRole('radio')]) {
        // `Checkbox` wraps its input in the label; `RadioButton` renders the two as siblings. Either
        // way the label is the box the input is stretched over.
        const box = control.closest('label') ?? control.parentElement?.querySelector('label') ?? null;
        expect(box).not.toBeNull();
        expect({ name: control.getAttribute('name'), minHeight: window.getComputedStyle(box!).minHeight }).toEqual({
          name: control.getAttribute('name'),
          minHeight: '44px',
        });
        // The input is what the pointer lands on, and it fills that box.
        expect(window.getComputedStyle(control).height).toBe('100%');
      }

      const start = screen.getByRole('button', { name: /start test playlist/i });
      const { minWidth, minHeight } = window.getComputedStyle(start);
      expect({ minWidth, minHeight }).toEqual({ minWidth: '44px', minHeight: '44px' });

      // The dismiss control is supplied by `Modal` itself as a 24 px `IconButton`, and is the only
      // way out of the dialog other than Escape. It is reached through the stable testid it
      // carries rather than its translated accessible name.
      const close = screen.getByTestId(selectors.components.Modal.closeButton);
      expect(window.getComputedStyle(close)).toMatchObject({ minWidth: '44px', minHeight: '44px' });

      // The checkmark itself is unchanged: the box grew around it.
      const [checkmark] = Array.from(
        screen.getAllByRole('checkbox')[0].closest('label')!.querySelectorAll<HTMLElement>('span')
      );
      const { width, height } = window.getComputedStyle(checkmark);
      expect({ width, height }).toEqual({ width: '16px', height: '16px' });
    });

    it('keeps every checkbox uniquely identified and singly labelled at the larger size', async () => {
      const { user } = setup();

      // The grouping and the ids are what an audit of this dialog checks, and growing the label box
      // must not have moved either: the label is still the only thing naming its own checkbox.
      expectUniqueIdsAndOneLabelEach();
      expect(screen.getByRole('group', { name: /display dashboard controls/i })).toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: /kiosk/i }));
      expectUniqueIdsAndOneLabelEach();
    });

    /**
     * The same question the id and label assertions above ask, put to axe over the whole dialog
     * instead of to one hand-written rule at a time: growing the label boxes must not have cost the
     * modal any of the structure an audit reads it by.
     *
     * `color-contrast` is the one rule turned off, because it is the one rule that cannot run here:
     * jsdom has no layout and no compositing, so axe cannot resolve the colour actually painted
     * behind an element and would report the whole dialog as `incomplete` rather than as passing or
     * failing. The contrast of this feature's controls is measured against the real rendered page
     * instead.
     */
    it.each([
      ['Normal', false],
      ['Kiosk', true],
    ])(
      'reports no axe violations over the dialog in %s mode',
      async (_mode, selectKiosk) => {
        const { user } = setup();
        if (selectKiosk) {
          await user.click(screen.getByRole('radio', { name: /kiosk/i }));
        }

        // Inside `act` because the run is asynchronous and `Modal`'s open transition completes on a
        // timer during it: that completion is a React state update, and without `act` around the
        // await it lands outside one.
        let results: axe.AxeResults | undefined;
        await act(async () => {
          results = await axe.run(screen.getByRole('dialog'), {
            rules: { 'color-contrast': { enabled: false } },
          });
        });
        if (!results) {
          throw new Error('axe returned no results');
        }

        // Mapped to the rule id and the offending markup: the bare array prints as unreadable depth
        // in a failure, and the id plus the element is what identifies the control to fix.
        expect(
          results.violations.map((violation) => ({
            rule: violation.id,
            nodes: violation.nodes.map((node) => node.html),
          }))
        ).toEqual([]);
        // A run that matched nothing would also report no violations, so the run itself is checked.
        expect(results.passes.length).toBeGreaterThan(0);
      },
      30000
    );
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

    // Guards the whole Normal-mode parameter set, so hiding the navigation option in kiosk cannot
    // silently drop one of the others.
    it('pushes every dashboard control parameter it was asked for in Normal mode', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('checkbox', { name: /^autofit/i }));
      await user.click(screen.getByRole('checkbox', { name: /^time and refresh/i }));
      await user.click(screen.getByRole('checkbox', { name: /^variables/i }));
      await user.click(screen.getByRole('checkbox', { name: /^dashboard links/i }));
      await user.click(screen.getByRole('checkbox', { name: /navigation buttons/i }));
      await user.click(screen.getByRole('button', { name: /start/i }));

      const url = jest.mocked(locationService.push).mock.calls[0][0];
      expect(url).toContain('/playlists/play/test-playlist-uid');
      expect(url).toContain('autofitpanels=true');
      expect(url).toContain('_dash.hideTimePicker=true');
      expect(url).toContain('_dash.hideVariables=true');
      expect(url).toContain('_dash.hideLinks=true');
      expect(url).toContain('_dash.hidePlaylistNav=true');
      expect(url).not.toContain('kiosk');
      expect(url).not.toContain('hideLogo');
    });

    it('includes _dash.hidePlaylistNav in the URL when Navigation buttons is cleared in Normal mode', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('checkbox', { name: /navigation buttons/i }));
      await user.click(screen.getByRole('button', { name: /start/i }));
      expect(locationService.push).toHaveBeenCalledWith(expect.stringContaining('_dash.hidePlaylistNav=true'));
    });

    it('does not include _dash.hidePlaylistNav in the URL when Navigation buttons is left checked', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('button', { name: /start/i }));
      expect(locationService.push).toHaveBeenCalledWith(expect.not.stringContaining('_dash.hidePlaylistNav'));
    });

    // The parameter only controls a row kiosk does not render, so kiosk must not carry a hidden
    // preference the modal stopped offering.
    it('does not include _dash.hidePlaylistNav in the URL in kiosk mode, even after clearing it in Normal mode', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('checkbox', { name: /navigation buttons/i }));
      await user.click(screen.getByRole('radio', { name: /kiosk/i }));
      await user.click(screen.getByRole('button', { name: /start/i }));

      expect(locationService.push).toHaveBeenCalledWith(expect.stringContaining('kiosk'));
      expect(locationService.push).toHaveBeenCalledWith(expect.not.stringContaining('_dash.hidePlaylistNav'));
    });
  });
});
