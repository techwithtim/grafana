import { render, screen, testWithFeatureToggles, waitFor } from 'test/test-utils';

import { selectors } from '@grafana/e2e-selectors';
import { setBackendSrv } from '@grafana/runtime';
import { setupMockServer } from '@grafana/test-utils/server';
import { getFolderFixtures } from '@grafana/test-utils/unstable';
import { Field } from '@grafana/ui';
import { backendSrv } from 'app/core/services/backend_srv';
import * as dashboardApi from 'app/features/dashboard/api/dashboard_api';

import { DashboardPicker } from './DashboardPicker';

setBackendSrv(backendSrv);
setupMockServer();

const [_, { folderA, folderA_dashbdD }] = getFolderFixtures();

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

describe('DashboardPicker', () => {
  describe('using app platform', () => {
    const onChange = jest.fn();

    testWithFeatureToggles({ enable: [] });

    it('should fetch and display dashboards', async () => {
      render(<DashboardPicker value={folderA_dashbdD.item.uid} />);

      expect(await screen.findByText(`${folderA.item.title}/${folderA_dashbdD.item.title}`)).toBeInTheDocument();
    });

    it('should search for dashboards and allow selection', async () => {
      const { user } = render(<DashboardPicker onChange={onChange} />);

      const expectedDash = folderA_dashbdD.item;
      const expectedFolder = folderA.item;

      await user.type(screen.getByRole('combobox'), expectedDash.title);

      expect(await screen.findByText(`${expectedFolder.title}/${expectedDash.title}`)).toBeInTheDocument();

      await user.click(screen.getByText(`${expectedFolder.title}/${expectedDash.title}`));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          folderTitle: expectedFolder.title,
          folderUid: expectedFolder.uid,
          name: expectedDash.title,
          uid: expectedDash.uid,
        })
      );
    });

    it.each([
      ['id', <DashboardPicker id="dashboard-picker" key="by-id" />],
      ['inputId', <DashboardPicker inputId="dashboard-picker" key="by-input-id" />],
    ])('should name the combobox from its Field label when the consumer passes %s', async (_prop, picker) => {
      render(<Field label="Add by title">{picker}</Field>);

      const combobox = await screen.findByRole('combobox', { name: 'Add by title' });

      // `Field` derives its `label[for]` target from the child's `id`/`inputId`, so that string has
      // to land on the input and nowhere else: while react-select also carried it on its
      // non-labelable container div, `label[for]` resolved to that div (first in document order)
      // and the combobox was left with an empty accessible name.
      const withPickerId = document.querySelectorAll('#dashboard-picker');
      expect(withPickerId).toHaveLength(1);
      expect(withPickerId[0]).toBe(combobox);
    });

    it('should return to its placeholder after a selection when clearOnSelect is set', async () => {
      const onChange = jest.fn();
      const { user } = render(<DashboardPicker clearOnSelect onChange={onChange} />);

      const expectedDash = folderA_dashbdD.item;
      const expectedFolder = folderA.item;
      const expectedLabel = `${expectedFolder.title}/${expectedDash.title}`;

      await user.type(screen.getByRole('combobox'), expectedDash.title);
      await user.click(await screen.findByText(expectedLabel));

      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ uid: expectedDash.uid }));
      // The picker holds no value of its own in "add an item" controls, so the chosen dashboard is
      // handed to `onChange` and the control shows its placeholder again.
      await waitFor(() => {
        expect(screen.queryByText(expectedLabel)).not.toBeInTheDocument();
      });
      expect(screen.getByText('Select dashboard')).toBeInTheDocument();
    });

    it('should keep the very same combobox input mounted across a keyboard selection', async () => {
      const onChange = jest.fn();
      const { user } = render(<DashboardPicker clearOnSelect onChange={onChange} />);

      const expectedDash = folderA_dashbdD.item;
      const combobox = screen.getByRole('combobox');

      await user.type(combobox, expectedDash.title);
      expect(await screen.findByText(`${folderA.item.title}/${expectedDash.title}`)).toBeInTheDocument();
      // Enter commits whichever option the menu has focused; which one that is belongs to the
      // selection cases above, and only that a selection happened matters here.
      await user.keyboard('{Enter}');

      expect(onChange).toHaveBeenCalledTimes(1);
      // Losing the focused input is what dropped `document.activeElement` to the document body, so
      // the identical node has to survive a selection. Whether focus is then still on it is
      // react-select's `blurInputOnSelect`, which resolves per platform — false on a desktop
      // browser, but true under jsdom, where `document.createEvent('TouchEvent')` is supported — so
      // that part is left to a browser check rather than asserted here.
      expect(screen.getByRole('combobox')).toBe(combobox);
      expect(document.body).toContainElement(combobox);
    });

    it('should keep displaying the selected dashboard without clearOnSelect', async () => {
      const onChange = jest.fn();
      const { user } = render(<DashboardPicker onChange={onChange} />);

      const expectedDash = folderA_dashbdD.item;
      const expectedLabel = `${folderA.item.title}/${expectedDash.title}`;

      await user.type(screen.getByRole('combobox'), expectedDash.title);
      await user.click(await screen.findByText(expectedLabel));

      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ uid: expectedDash.uid }));
      // Every other consumer of this picker displays the dashboard it is bound to, so the opt-in
      // flag above must not change what they see.
      expect(screen.getByText(expectedLabel)).toBeInTheDocument();
      expect(screen.queryByText('Select dashboard')).not.toBeInTheDocument();
    });

    it('should render an unknown current value that can be cleared when clearable', async () => {
      const onChange = jest.fn();
      const { user } = render(
        <DashboardPicker value="unknown-dashboard-uid" isClearable onChange={onChange} showUnknown />
      );

      await screen.findByText('Unknown dashboard (unknown-dashboard-uid)');
      await user.click(await screen.findByRole('button', { name: 'Clear value' }));

      expect(onChange).toHaveBeenCalledWith(undefined);
    });

    /**
     * A menu that cannot fit the screen has to give way by wrapping, never by growing.
     *
     * grafana-ui sizes the portalled menu from its content and marks every option `nowrap`, which
     * makes an option's minimum width its full length: at a 375px viewport a menu holding one long
     * `folder/dashboard` title measured 668px, 310px of it off-screen with no horizontal page
     * scroll to reach it. jsdom does no layout, so what is asserted here is the geometry input the
     * browser resolves that width from — the option's own text may wrap and break, and the menu is
     * capped at the viewport — rather than a pixel width.
     */
    it('should let long option content wrap and cap the menu at the viewport width', async () => {
      const { user } = render(<DashboardPicker />);

      await user.click(screen.getByRole('combobox'));

      const optionLabel = await screen.findByText(`${folderA.item.title}/${folderA_dashbdD.item.title}`);
      // The wrapping belongs to the option's own content, which is what carries the width.
      expect(optionLabel.closest(`[data-testid="${selectors.components.Select.option}"]`)).toBeInTheDocument();
      expect(optionLabel).toHaveStyle({ whiteSpace: 'normal', overflowWrap: 'anywhere' });

      // grafana-ui's own menu list (the labelled element) sits inside react-select's menu, which is
      // the box that used to overhang the viewport.
      const menu = screen.getByLabelText('Select options menu').parentElement;
      expect(menu).toHaveStyle({ maxWidth: '100vw' });
    });

    it('should render the selected dashboard in the control without the menu wrapping', async () => {
      const { user } = render(<DashboardPicker onChange={jest.fn()} />);

      const expectedLabel = `${folderA.item.title}/${folderA_dashbdD.item.title}`;
      await user.type(screen.getByRole('combobox'), folderA_dashbdD.item.title);
      await user.click(await screen.findByText(expectedLabel));

      // The wrapping applies to the menu only, so the pickers that display their selection are
      // unaffected: the control shows the label as plain text, exactly as it did before.
      const selectedValue = await screen.findByText(expectedLabel);
      expect(selectedValue).not.toHaveStyle({ overflowWrap: 'anywhere' });
      expect(screen.queryByLabelText('Select options menu')).not.toBeInTheDocument();
    });

    it('should keep a formatOptionLabel a consumer provides, wrapping its menu output', async () => {
      const formatOptionLabel = jest.fn((item, meta) => `${meta.context}:${item.label}`);
      const { user } = render(<DashboardPicker formatOptionLabel={formatOptionLabel} />);

      await user.click(screen.getByRole('combobox'));

      const optionLabel = await screen.findByText(`menu:${folderA.item.title}/${folderA_dashbdD.item.title}`);
      expect(optionLabel).toHaveStyle({ whiteSpace: 'normal' });
    });

    it('should ignore stale unknown fallback when value changes to another dashboard', async () => {
      const unknownUid = 'deleted-dashboard-uid';
      const pendingUnknown = createDeferred<never>();
      const getDashboardDTO = jest
        .fn()
        .mockImplementationOnce(() => pendingUnknown.promise)
        .mockResolvedValueOnce({
          dashboard: { uid: folderA_dashbdD.item.uid, title: folderA_dashbdD.item.title },
          meta: { folderTitle: folderA.item.title, folderUid: folderA.item.uid },
        });
      const apiSpy = jest
        .spyOn(dashboardApi, 'getDashboardAPI')
        .mockResolvedValue({ getDashboardDTO } as unknown as Awaited<ReturnType<typeof dashboardApi.getDashboardAPI>>);

      const { rerender } = render(<DashboardPicker value={unknownUid} showUnknown />);

      rerender(<DashboardPicker value={folderA_dashbdD.item.uid} showUnknown />);

      expect(await screen.findByText(`${folderA.item.title}/${folderA_dashbdD.item.title}`)).toBeInTheDocument();

      pendingUnknown.reject(new Error('not found'));

      await waitFor(() => {
        expect(screen.queryByText(`Unknown dashboard (${unknownUid})`)).not.toBeInTheDocument();
      });

      apiSpy.mockRestore();
    });
  });

  xdescribe('dashboard v2 (v2beta1 API)', () => {
    testWithFeatureToggles({ enable: ['dashboardNewLayouts'] });
    it('renders dashboard correctly', async () => {
      render(<DashboardPicker value="v2-special-case-override" />);
      expect(await screen.findByText('TODO')).toBeInTheDocument();
    });
  });
});
