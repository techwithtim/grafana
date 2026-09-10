import { css, cx } from '@emotion/css';
import debounce from 'debounce-promise';
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { components as reactSelectComponents, type MenuProps } from 'react-select';

import { type SelectableValue } from '@grafana/data';
import { t } from '@grafana/i18n';
import { type AsyncSelectProps, type FormatOptionLabelMeta, AsyncSelect, useStyles2 } from '@grafana/ui';
import { AnnoKeyFolder, AnnoKeyFolderTitle } from 'app/features/apiserver/types';
import { getDashboardAPI } from 'app/features/dashboard/api/dashboard_api';
import { isDashboardV2Resource } from 'app/features/dashboard/api/utils';
import { getGrafanaSearcher } from 'app/features/search/service/searcher';
import { type DashboardQueryResult } from 'app/features/search/service/types';
import { type DashboardDTO } from 'app/types/dashboard';

interface Props extends Omit<AsyncSelectProps<DashboardPickerDTO>, 'value' | 'onChange' | 'loadOptions' | ''> {
  value?: DashboardPickerDTO['uid'];
  onChange?: (value?: DashboardPickerDTO) => void;
  showUnknown?: boolean;
  /**
   * Returns the picker to its placeholder after a selection instead of displaying the chosen
   * dashboard. For "add an item" controls, which hand the selection to their owner and hold no
   * value of their own. Left unset, the picker keeps showing what was picked.
   */
  clearOnSelect?: boolean;
}

export type DashboardPickerDTO = Pick<DashboardQueryResult, 'uid' | 'name'> &
  Pick<DashboardDTO['meta'], 'folderUid' | 'folderTitle'>;

/**
 * `controlShouldRenderValue` is a react-select prop that grafana-ui's `AsyncSelect` props do not
 * enumerate but do forward verbatim, so it is declared here to pass it type-safely. It is what
 * `clearOnSelect` needs: clearing our own state is not enough, because grafana-ui reduces a falsy
 * `value` to `undefined` and react-select then falls back to the selection it holds internally.
 */
type ReactSelectValueDisplayProps = {
  controlShouldRenderValue?: boolean;
};

const formatLabel = (folderTitle = 'Dashboards', dashboardTitle: string) => `${folderTitle}/${dashboardTitle}`;

/**
 * The option menu, kept inside the viewport.
 *
 * grafana-ui sizes the portalled menu from its own content: it replaces react-select's menu style,
 * dropping `width: 100%` and leaving `minWidth: 100%`, so the absolutely positioned menu
 * shrink-to-fits inside the fixed wrapper react-select gives the control's width. Because every
 * option is `white-space: nowrap`, an option's minimum width equals its full length, and that
 * minimum wins over the space available: measured on a 375px viewport, a menu holding one long
 * `folder/dashboard` title was 668px wide with 310px of it off-screen, unreachable because the page
 * itself does not scroll horizontally.
 *
 * Wrapping the option content (see `renderOptionLabel`) is what removes that forced minimum, and
 * this cap covers the remaining case: a control that is itself wider than the screen can no longer
 * pull the menu off it. `maxWidth` is the only declaration added — the menu's appearance and its
 * positioning stay entirely with grafana-ui — and it is inert wherever the menu already fits.
 */
const ViewportConstrainedMenu = (props: MenuProps<SelectableValue<DashboardPickerDTO>, false>) => {
  const styles = useStyles2(getStyles);

  return <reactSelectComponents.Menu {...props} className={cx(props.className, styles.menuWithinViewport)} />;
};

/** Merged with anything a consumer passes, so an explicit `components` override still wins. */
const dashboardPickerComponents = { Menu: ViewportConstrainedMenu };

async function findDashboards(query = '') {
  const result = await getGrafanaSearcher().search({ query, kind: ['dashboard'], limit: 100 });
  const locationInfo = await getGrafanaSearcher().getLocationInfo();

  return result.view.toArray().map((item) => {
    const folderTitle = locationInfo[item.location]?.name;
    return {
      value: {
        uid: item.uid,
        name: item.name,
        folderTitle,
        folderUid: item.location,
      },
      label: formatLabel(folderTitle, item.name),
    };
  });
}

const getDashboards = debounce(findDashboards, 250, { leading: true });

// TODO: this component should provide a way to apply different filters to the search APIs
export const DashboardPicker = forwardRef<HTMLElement, Props>(
  (
    {
      value,
      onChange,
      placeholder,
      noOptionsMessage,
      showUnknown,
      clearOnSelect,
      id,
      inputId,
      components,
      formatOptionLabel,
      ...props
    },
    ref
  ) => {
    const [current, setCurrent] = useState<SelectableValue<DashboardPickerDTO>>();
    const abortRef = useRef<AbortController | null>(null);
    const styles = useStyles2(getStyles);

    // This is required because the async select does not match the raw uid value
    // We can not use a simple Select because the dashboard search should not return *everything*
    useEffect(() => {
      if (!value || value === current?.value?.uid) {
        return;
      }

      const abortController = new AbortController();
      abortRef.current = abortController;
      const setCurrentIfLatest = (next: SelectableValue<DashboardPickerDTO>) => {
        if (!abortController.signal.aborted) {
          setCurrent(next);
        }
      };

      (async () => {
        // value was manually changed from outside or we are rendering for the first time.
        // We need to fetch dashboard information.
        try {
          const api = await getDashboardAPI();
          const dto = await api.getDashboardDTO(value, undefined);

          if (isDashboardV2Resource(dto)) {
            setCurrentIfLatest({
              value: {
                uid: dto.metadata.name,
                name: dto.spec.title,
                folderTitle: dto.metadata.annotations?.[AnnoKeyFolderTitle],
                folderUid: dto.metadata.annotations?.[AnnoKeyFolder],
              },
              label: formatLabel(dto.metadata.annotations?.[AnnoKeyFolder], dto.spec.title),
            });
          } else {
            if (dto.dashboard) {
              setCurrentIfLatest({
                value: {
                  uid: dto.dashboard.uid,
                  name: dto.dashboard.title,
                  folderTitle: dto.meta.folderTitle,
                  folderUid: dto.meta.folderUid,
                },
                label: formatLabel(dto.meta?.folderTitle, dto.dashboard.title),
              });
            }
          }
        } catch {
          if (showUnknown) {
            const name = t('dashboard-picker.unknown-dashboard', 'Unknown dashboard ({{uid}})', { uid: value });
            setCurrentIfLatest({
              value: {
                uid: value,
                name,
              },
              label: name,
            });
          }
        }
      })();

      return () => {
        abortController.abort();
      };
      // we don't need to rerun this effect every time `current` changes
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, showUnknown]);

    const onPicked = useCallback(
      (sel: SelectableValue<DashboardPickerDTO>) => {
        abortRef.current?.abort();
        setCurrent(clearOnSelect ? undefined : sel);
        onChange?.(sel?.value);
      },
      [clearOnSelect, onChange, setCurrent]
    );

    const selectComponents = useMemo(() => ({ ...dashboardPickerComponents, ...components }), [components]);

    /**
     * Option content that can wrap, so a `folder/dashboard` title longer than the screen no longer
     * forces the menu wider than the space beside the control (see `ViewportConstrainedMenu`).
     *
     * Only the menu is affected: react-select asks for the same label to render the current
     * selection inside the control, and that context is handed back untouched, so every picker that
     * displays what it is bound to keeps showing it on one line exactly as before.
     */
    const renderOptionLabel = useCallback(
      (item: SelectableValue<DashboardPickerDTO>, meta: FormatOptionLabelMeta<DashboardPickerDTO>) => {
        const content = formatOptionLabel ? formatOptionLabel(item, meta) : item.label;

        return meta.context === 'menu' ? <span className={styles.wrappingOptionLabel}>{content}</span> : content;
      },
      [formatOptionLabel, styles.wrappingOptionLabel]
    );

    return (
      <AsyncSelect<DashboardPickerDTO, ReactSelectValueDisplayProps>
        loadOptions={getDashboards}
        onChange={onPicked}
        placeholder={placeholder ?? t('dashboard-picker.placeholder', 'Select dashboard')}
        noOptionsMessage={noOptionsMessage ?? t('dashboard-picker.no-options', 'No dashboards found')}
        value={current}
        defaultOptions={true}
        {...props}
        // An `id` given to a Select is forwarded to react-select's container div, which is not
        // labelable, while grafana-ui `Field` points its `label[for]` at that same string — so the
        // combobox ended up unnamed and the id sat on two nodes. Both forms are routed to the input
        // instead, and `id` is never forwarded on, which leaves `label[for]` resolving to the
        // combobox.
        inputId={inputId ?? id}
        // `true` is react-select's own default, so this is inert unless `clearOnSelect` is set.
        controlShouldRenderValue={!clearOnSelect}
        components={selectComponents}
        formatOptionLabel={renderOptionLabel}
        selectRef={ref}
      />
    );
  }
);
DashboardPicker.displayName = 'DashboardPicker';

const getStyles = () => ({
  // `normal` overrides the `nowrap` every option inherits from grafana-ui, and `anywhere` lets even
  // a single unbroken title break, so the option's minimum width can never exceed what it is given.
  wrappingOptionLabel: css({
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
  }),
  menuWithinViewport: css({
    maxWidth: '100vw',
  }),
});
