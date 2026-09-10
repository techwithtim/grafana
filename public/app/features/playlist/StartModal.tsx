import { css } from '@emotion/css';
import { useId, useState } from 'react';

import { type GrafanaTheme2, type SelectableValue, type UrlQueryMap, urlUtil } from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors';
import { Trans, t } from '@grafana/i18n';
import { config, locationService, reportInteraction } from '@grafana/runtime';
import { Box, Button, Checkbox, Field, FieldSet, Modal, RadioButtonGroup, Stack, Text, useStyles2 } from '@grafana/ui';

import { type Playlist } from '../../api/clients/playlist/v1';

import { type PlaylistMode } from './types';

export interface Props {
  playlist: Playlist;
  onDismiss: () => void;
}

/**
 * The smallest box, in pixels, any control of this modal offers a pointer.
 *
 * The same minimum the playlist editor applies, which is where the reasoning for the number is
 * recorded (`MIN_HIT_TARGET_SIZE` in `PlaylistItemVariables`). It is repeated rather than imported
 * because this modal ships with the playlist list page, and importing the constant would pull the
 * whole variables editor into that page's bundle for one number.
 */
const MIN_HIT_TARGET_SIZE = 44;

export const StartModal = ({ playlist, onDismiss }: Props) => {
  const styles = useStyles2(getStyles);
  const [mode, setMode] = useState<PlaylistMode>(false);
  const [autoFit, setAutofit] = useState(false);
  const [hideLogo, setHideLogo] = useState(false);
  const [displayTimePicker, setDisplayTimePicker] = useState(true);
  const [displayVariables, setDisplayVariables] = useState(true);
  const [displayLinks, setDisplayLinks] = useState(true);
  const [displayPlaylistNav, setDisplayPlaylistNav] = useState(true);

  // Every checkbox gets an explicit id derived from one instance-scoped prefix. Without it, Checkbox
  // falls back to the id published by its surrounding Field, and the three grouped "Display dashboard
  // controls" checkboxes share a single Field, so all three would render the same id and that Field's
  // label would attach to whichever input the document resolved first.
  const idPrefix = useId();
  const autoFitId = `${idPrefix}-autofit`;
  const hideLogoId = `${idPrefix}-hide-logo`;
  const displayPlaylistNavId = `${idPrefix}-playlist-nav`;
  const displayTimePickerId = `${idPrefix}-time-picker`;
  const displayVariablesId = `${idPrefix}-variables`;
  const displayLinksId = `${idPrefix}-links`;

  const modes: Array<SelectableValue<PlaylistMode>> = [
    { label: t('playlist.start-modal.modes.label.normal', 'Normal'), value: false },
    { label: t('playlist.start-modal.modes.label.kiosk', 'Kiosk'), value: true },
  ];

  const onStart = () => {
    const params: UrlQueryMap = {};
    if (mode) {
      params.kiosk = mode;
    }
    if (autoFit) {
      params.autofitpanels = true;
    }
    if (hideLogo) {
      params.hideLogo = '1';
    }

    if (!displayTimePicker) {
      params['_dash.hideTimePicker'] = true;
    }
    if (!displayVariables) {
      params['_dash.hideVariables'] = true;
    }
    if (!displayLinks) {
      params['_dash.hideLinks'] = true;
    }
    // Only meaningful outside kiosk: full kiosk removes the whole dashboard actions row, so the
    // playlist navigation buttons are already absent and the parameter has nothing to hide. Sending
    // it anyway would take effect only after the user pressed Esc to leave kiosk, contradicting the
    // notice above, which promises Esc brings the playlist controls back.
    if (!mode && !displayPlaylistNav) {
      params['_dash.hidePlaylistNav'] = true;
    }

    locationService.push(urlUtil.renderUrl(`/playlists/play/${playlist.metadata?.name}`, params));
    reportInteraction('grafana_kiosk_mode', {
      action: 'start_playlist',
      mode: mode,
    });
  };

  return (
    <Modal
      className={styles.dialog}
      isOpen={true}
      title={t('playlist.start-modal.title-start-playlist', 'Start playlist')}
      onDismiss={onDismiss}
    >
      <FieldSet>
        <Stack direction="column" alignItems="start" justifyContent="left" gap={2}>
          <Field noMargin label={t('playlist.start-modal.label-mode', 'Mode')}>
            <RadioButtonGroup
              className={styles.radioGroup}
              value={mode}
              options={modes}
              onChange={(v) => {
                setMode(v);
                if (!v) {
                  setHideLogo(false);
                }
              }}
            />
          </Field>
          {/* Tied to the kiosk selection because kiosk is the only mode that hides the playback controls,
              so the consequence is stated at the moment the user chooses it rather than after playback starts. */}
          {mode && (
            <Text variant="bodySmall" color="secondary" element="p" role="status">
              <Trans i18nKey="playlist.start-modal.description-kiosk-controls">
                Kiosk mode hides the playlist controls. Press the Esc key to exit kiosk mode and show them, including
                Stop playlist.
              </Trans>
            </Text>
          )}
          <Field noMargin>
            <Checkbox
              className={styles.checkbox}
              label={t('playlist.start-modal.label-autofit', 'Autofit')}
              description={t(
                'playlist.start-modal.description-panel-heights-adjusted-screen',
                'Panel heights will be adjusted to fit screen size'
              )}
              id={autoFitId}
              name="autofix"
              value={autoFit}
              onChange={(e) => setAutofit(e.currentTarget.checked)}
            />
          </Field>
          {mode && (
            <Field noMargin>
              <Checkbox
                className={styles.checkbox}
                label={t('playlist.start-modal.label-hide-logo', 'Hide logo')}
                description={t(
                  'playlist.start-modal.description-hide-logo',
                  'Hide the branding footer from the dashboard'
                )}
                id={hideLogoId}
                name="hideLogo"
                value={hideLogo}
                onChange={(e) => setHideLogo(e.currentTarget.checked)}
              />
            </Field>
          )}
          {/* Offered for normal playback only: kiosk suppresses the dashboard actions row that hosts the
              previous/stop/next buttons, so the option could not change anything there. The kiosk notice
              above carries that explanation. The checkbox state is kept while it is hidden, so switching
              back to Normal restores the choice the user made. */}
          {config.featureToggles.dashboardNewLayouts && !mode && (
            <Field noMargin>
              <Checkbox
                className={styles.checkbox}
                label={t('playlist.start-modal.label-playlist-nav', 'Navigation buttons')}
                description={t(
                  'playlist.start-modal.description-playlist-nav',
                  'Show previous and next buttons to manually navigate between dashboards'
                )}
                id={displayPlaylistNavId}
                name="displayPlaylistNav"
                value={displayPlaylistNav}
                onChange={(e) => setDisplayPlaylistNav(e.currentTarget.checked)}
              />
            </Field>
          )}
          {/* useFieldset renders the group heading as a <legend>, which names the three checkboxes as a
              group. A plain Field label would instead emit a single label[for] that can only point at one
              of them, giving that one checkbox a second, misleading label. */}
          <Field
            noMargin
            useFieldset
            label={t('playlist.start-modal.label-display-dashboard-controls', 'Display dashboard controls')}
            description={t(
              'playlist.start-modal.description-customize-dashboard-elements-visibility',
              'Customize dashboard elements visibility'
            )}
          >
            <Box marginTop={2} marginBottom={2}>
              <Stack direction="column" alignItems="start" justifyContent="left" gap={2}>
                <Checkbox
                  className={styles.checkbox}
                  label={t('playlist.start-modal.label-time-and-refresh', 'Time and refresh')}
                  id={displayTimePickerId}
                  name="displayTimePicker"
                  value={displayTimePicker}
                  onChange={(e) => setDisplayTimePicker(e.currentTarget.checked)}
                />
                <Checkbox
                  className={styles.checkbox}
                  label={t('playlist.start-modal.label-variables', 'Variables')}
                  description={t(
                    'playlist.start-modal.description-variables',
                    'A playlist applies template variable values per dashboard and displays them in these controls, so clearing this option hides which values are in use'
                  )}
                  id={displayVariablesId}
                  name="displayVariableControls"
                  value={displayVariables}
                  onChange={(e) => setDisplayVariables(e.currentTarget.checked)}
                />
                <Checkbox
                  className={styles.checkbox}
                  label={t('playlist.start-modal.label-dashboard-links', 'Dashboard links')}
                  id={displayLinksId}
                  name="displayLinks"
                  value={displayLinks}
                  onChange={(e) => setDisplayLinks(e.currentTarget.checked)}
                />
              </Stack>
            </Box>
          </Field>
        </Stack>
      </FieldSet>
      <Modal.ButtonRow>
        <Button variant="primary" className={styles.startButton} onClick={onStart}>
          <Trans i18nKey="playlist.start-modal.button-start" values={{ title: playlist.spec?.title }}>
            Start {'{{title}}'}
          </Trans>
        </Button>
      </Modal.ButtonRow>
    </Modal>
  );
};

function getStyles(theme: GrafanaTheme2) {
  return {
    /**
     * A checkbox's 44 px box.
     *
     * `Checkbox` lays its checkmark, its label and its description out in a grid and covers the
     * whole of that grid with the real `<input>` — absolutely positioned at 100% of the label — so
     * the label box is the hit area, and a checkbox with no description was as tall as one line of
     * text. The minimum is set on the label, which the input then fills; the checkmark keeps its
     * own 16 px and stays on the label's centre line, because the grid already centres its rows.
     */
    checkbox: css({
      minHeight: MIN_HIT_TARGET_SIZE,
    }),
    /**
     * The Normal/Kiosk options' 44 px boxes.
     *
     * `RadioButton` gives each option's label an explicit 26 px height and covers the option with
     * its own `<input>` at 100% height, so the minimum belongs on the label and the input follows
     * it. The label is already a centring flex container, so its text does not move; `minHeight`
     * rather than `height` because the label's own declaration is a height and the larger of the
     * two is what applies.
     */
    radioGroup: css({
      label: {
        minHeight: MIN_HIT_TARGET_SIZE,
      },
    }),
    /**
     * The dismiss control's 44 px box.
     *
     * `Modal` supplies its own close button rather than taking it from its children, and renders it
     * as an `IconButton size="xl"` — a 24 px box, and the only way out of this dialog other than
     * Escape. It is reached through the stable e2e selector it already carries rather than through
     * its accessible name, which is translated, or its position, which is markup detail. The
     * override is scoped to this dialog by `className`, so no other modal in the product changes;
     * the header's own `min-height` is 42 px, so it grows by 2 px to hold the larger box.
     */
    dialog: css({
      [`[data-testid="${selectors.components.Modal.closeButton}"]`]: {
        minWidth: MIN_HIT_TARGET_SIZE,
        minHeight: MIN_HIT_TARGET_SIZE,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
    }),
    /** The 44 px box for Start, which a `size="md"` `Button` is 12 px short of. */
    startButton: css({
      minWidth: MIN_HIT_TARGET_SIZE,
      minHeight: MIN_HIT_TARGET_SIZE,
      justifyContent: 'center',
    }),
  };
}
