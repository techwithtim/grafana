import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import {
  PlaylistItemVariables,
  PlaylistVariablesCommitContext,
  usePlaylistVariablesCommit,
} from './PlaylistItemVariables';
import {
  MAX_VALUES_PER_VARIABLE,
  MAX_VARIABLE_NAME_LENGTH,
  MAX_VARIABLE_NAME_TEXT_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  MAX_VARIABLE_VALUES_TEXT_LENGTH,
  MAX_VARIABLES_PER_ITEM,
} from './variableLimits';

const NAME_REQUIRED = 'Variable name is required';
const VALUE_REQUIRED = 'Variable value is required';
const DUPLICATE_NAME = 'A variable with this name already exists';
const NAME_TOO_LONG = `Variable name cannot be longer than ${MAX_VARIABLE_NAME_LENGTH} characters`;
const TOO_MANY_VALUES = `A variable cannot have more than ${MAX_VALUES_PER_VARIABLE} values`;
const VALUE_TOO_LONG = `A variable value cannot be longer than ${MAX_VARIABLE_VALUE_LENGTH} characters`;
const TOO_MANY_VARIABLES = `A playlist item cannot have more than ${MAX_VARIABLES_PER_ITEM} variables`;
const NOT_EDITABLE = 'These template variables cannot be edited';
const PENDING_HINT = 'This variable is not added yet. Select Add variable to include it.';

/**
 * Text that is longer than an input's own `maxLength` can only be committed the way a browser
 * commits a paste or an autofill, which is what this sets: `userEvent.type` respects `maxLength`
 * and would silently stop at the boundary the assertion is about.
 */
function setInputText(input: HTMLElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
}

/** A map of `count` single-value variables, used to sit either side of the per-item maximum. */
function manyVariables(count: number): Record<string, string[]> {
  const variables: Record<string, string[]> = {};
  for (let index = 0; index < count; index++) {
    variables[`k${index}`] = ['v'];
  }
  return variables;
}

function setup(jsx: JSX.Element) {
  return {
    user: userEvent.setup(),
    ...render(jsx),
  };
}

/**
 * Builds a variables map from entries, because an object literal treats some perfectly valid
 * variable names specially: `{ __proto__: ['a'] }` sets the map's prototype instead of adding a key.
 */
function variableMap(entries: Array<[string, string[]]>): Record<string, string[]> {
  return Object.fromEntries(entries);
}

/**
 * An `onChange` spy that also keeps what it received, so a test can look at the emitted map's own
 * keys instead of matching it — which is the only way to tell an own `__proto__` key from a
 * rewritten prototype.
 */
function changeSpy() {
  const emitted: Array<Record<string, string[]> | undefined> = [];
  const onChange = jest.fn((next?: Record<string, string[]>) => {
    emitted.push(next);
  });
  return { onChange, emitted };
}

/**
 * Mirrors the production parent: `PlaylistForm` applies what the editor emits to the playlist item
 * and hands it straight back as the `variables` prop, so the editor re-renders with a changed set
 * of names while another row may still hold text the user has not committed.
 */
function ControlledEditor({
  initial,
  onChange,
}: {
  initial: Record<string, string[]>;
  onChange: (next?: Record<string, string[]>) => void;
}) {
  const [current, setCurrent] = useState<Record<string, string[]> | undefined>(initial);
  return (
    <PlaylistItemVariables
      variables={current}
      onChange={(next) => {
        setCurrent(next);
        onChange(next);
      }}
    />
  );
}

/**
 * Mirrors the production parent one level higher: `PlaylistForm` provides the commit scope and
 * settles every open editor before it submits. `Settle` stands in for its Save button, and it
 * reports what the form would have learned. Focus is deliberately not moved by clicking it with
 * `fireEvent`, so a case can exercise a submit that arrives while a field is still being edited.
 */
function SettleHarness({
  initial,
  onChange,
  onSettle,
}: {
  initial?: Record<string, string[]>;
  onChange: (next?: Record<string, string[]>) => void;
  onSettle: (settled: boolean) => void;
}) {
  const { commitScope, settlePendingVariables } = usePlaylistVariablesCommit();
  const [current, setCurrent] = useState<Record<string, string[]> | undefined>(initial);
  return (
    <PlaylistVariablesCommitContext.Provider value={commitScope}>
      <PlaylistItemVariables
        variables={current}
        onChange={(next) => {
          setCurrent(next);
          onChange(next);
        }}
      />
      <button type="button" onClick={() => onSettle(settlePendingVariables())}>
        Settle
      </button>
    </PlaylistVariablesCommitContext.Provider>
  );
}

/**
 * Two editors under one commit scope, which is what the form has whenever two rows are expanded
 * at the same time. One refusal has to be reported without stopping the other editor from
 * settling, so the text a user left in the second one is not the price of a mistake in the first.
 */
function TwoEditorSettleHarness({
  onFirstChange,
  onSecondChange,
  onSettle,
}: {
  onFirstChange: (next?: Record<string, string[]>) => void;
  onSecondChange: (next?: Record<string, string[]>) => void;
  onSettle: (settled: boolean) => void;
}) {
  const { commitScope, settlePendingVariables } = usePlaylistVariablesCommit();
  return (
    <PlaylistVariablesCommitContext.Provider value={commitScope}>
      <div role="group" aria-label="First item">
        <PlaylistItemVariables onChange={onFirstChange} />
      </div>
      <div role="group" aria-label="Second item">
        <PlaylistItemVariables onChange={onSecondChange} />
      </div>
      <button type="button" onClick={() => onSettle(settlePendingVariables())}>
        Settle
      </button>
    </PlaylistVariablesCommitContext.Provider>
  );
}

/**
 * An editor that can be taken away, which is what collapsing a row does. Once it is gone the form
 * has nothing left to settle, so a message it was showing must not go on refusing every later save.
 */
function CollapsibleSettleHarness({
  onChange,
  onSettle,
}: {
  onChange: (next?: Record<string, string[]>) => void;
  onSettle: (settled: boolean) => void;
}) {
  const { commitScope, settlePendingVariables } = usePlaylistVariablesCommit();
  const [open, setOpen] = useState(true);
  return (
    <PlaylistVariablesCommitContext.Provider value={commitScope}>
      {open && <PlaylistItemVariables onChange={onChange} />}
      <button type="button" onClick={() => setOpen(false)}>
        Collapse
      </button>
      <button type="button" onClick={() => onSettle(settlePendingVariables())}>
        Settle
      </button>
    </PlaylistVariablesCommitContext.Provider>
  );
}

function settleButton() {
  return screen.getByRole('button', { name: 'Settle' });
}

/** The accessible names of the committed rows' name inputs, in the order they are rendered. */
function renderedRowNames() {
  return screen
    .getAllByRole('textbox')
    .map((input) => input.getAttribute('aria-label') ?? '')
    .filter((label) => label.startsWith('Variable name for '))
    .map((label) => label.replace('Variable name for ', ''));
}

function newName() {
  return screen.getByRole('textbox', { name: 'Variable name' });
}

function newValues() {
  return screen.getByRole('textbox', { name: 'Values (comma-separated)' });
}

function rowName(variable: string) {
  return screen.getByRole('textbox', { name: `Variable name for ${variable}` });
}

function rowValues(variable: string) {
  return screen.getByRole('textbox', { name: `Values for ${variable}` });
}

function addButton() {
  return screen.getByRole('button', { name: 'Add variable' });
}

function removeButton(variable: string) {
  return screen.getByRole('button', { name: `Remove variable ${variable}` });
}

/**
 * The grid the editor lays one variable's fields out in, found by walking up from one of those
 * fields. jsdom's `getComputedStyle` applies the class rules emotion injects, so the container is
 * the nearest ancestor computing to `display: grid` — which is also what makes the assertions
 * below independent of how many wrappers `Field` and `Input` put between the two.
 */
function gridContainerOf(element: HTMLElement): HTMLElement {
  for (let current = element.parentElement; current; current = current.parentElement) {
    if (window.getComputedStyle(current).display === 'grid') {
      return current;
    }
  }
  throw new Error('the variables editor field is not inside a grid container');
}

/** The `fr` numbers of a `grid-template-columns` track list, in track order. */
function fractionTracks(tracks: string): number[] {
  return Array.from(tracks.matchAll(/([\d.]+)fr/g), ([, fraction]) => Number(fraction));
}

/** The cell of `grid` that holds `element`, which is the element the grid's own gaps apply to. */
function gridItemOf(grid: HTMLElement, element: HTMLElement): HTMLElement {
  for (let current: HTMLElement = element; current.parentElement; current = current.parentElement) {
    if (current.parentElement === grid) {
      return current;
    }
  }
  throw new Error('the element is not inside the given grid');
}

/**
 * The editor's stacked layout, `theme.breakpoints.down('sm')` with the theme's 544 px `sm` and its
 * 0.05 px step.
 */
const MOBILE_MEDIA = '(max-width:543.95px)';

/**
 * jsdom's CSSOM exposes neither the rule constructors nor `CSSRule.MEDIA_RULE` on `window`, so the
 * two rule kinds below are told apart by the members each of them owns.
 */
function isMediaRule(rule: CSSRule): rule is CSSMediaRule {
  return 'media' in rule && 'cssRules' in rule;
}

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return 'selectorText' in rule && 'style' in rule;
}

/**
 * The pixel value `property` takes for `element` in the stacked layout, or 0 when nothing declares
 * it there.
 *
 * `getComputedStyle` cannot answer this: jsdom applies only the rules whose media list names
 * `screen`, so an `@media (max-width: …)` block is invisible to it however narrow the window is
 * said to be. The rule text is available though — emotion injects its rules as `<style>` elements
 * that jsdom parses into real stylesheets — so the mobile declarations are read straight out of
 * the media block. Every class on the element is considered because `cx` hands `Field` and
 * `IconButton` a single merged class, and the last declaration found wins, as it would in the
 * cascade.
 */
function mobilePixels(element: HTMLElement, property: string): number {
  const selectors = new Set(Array.from(element.classList, (name) => `.${name}`));
  let declared = '';

  for (const styleElement of Array.from(document.querySelectorAll('style'))) {
    for (const rule of Array.from(styleElement.sheet?.cssRules ?? [])) {
      if (!isMediaRule(rule) || (rule.conditionText || rule.media.mediaText).replace(/\s/g, '') !== MOBILE_MEDIA) {
        continue;
      }
      for (const inner of Array.from(rule.cssRules)) {
        if (isStyleRule(inner) && selectors.has(inner.selectorText)) {
          declared = inner.style.getPropertyValue(property) || declared;
        }
      }
    }
  }

  return declared ? Number.parseFloat(declared) : 0;
}

const rejectedAdditions: Array<{
  desc: string;
  variables?: Record<string, string[]>;
  name: string;
  values: string;
  error: string;
}> = [
  { desc: 'the name is left blank', name: '', values: 'a, b', error: NAME_REQUIRED },
  { desc: 'the name is nothing but spaces', name: '   ', values: 'a, b', error: NAME_REQUIRED },
  { desc: 'the values are left blank', name: 'host', values: '', error: VALUE_REQUIRED },
  { desc: 'the values are nothing but separators and spaces', name: 'host', values: ' , , ', error: VALUE_REQUIRED },
  {
    desc: 'the name is already used by another variable',
    variables: { host: ['a'] },
    name: 'host',
    values: 'b',
    error: DUPLICATE_NAME,
  },
];

/** One character, one value or one variable past each maximum, entered into the add row. */
const rejectedLimits: Array<{ desc: string; name: string; values: string; error: string }> = [
  {
    desc: 'the name is one character over the limit',
    name: 'n'.repeat(MAX_VARIABLE_NAME_LENGTH + 1),
    values: 'a',
    error: NAME_TOO_LONG,
  },
  {
    desc: 'one value more than the limit is entered',
    name: 'host',
    values: Array.from({ length: MAX_VALUES_PER_VARIABLE + 1 }, (_, index) => `v${index}`).join(','),
    error: TOO_MANY_VALUES,
  },
  {
    desc: 'a value is one character over the limit',
    name: 'host',
    values: 'v'.repeat(MAX_VARIABLE_VALUE_LENGTH + 1),
    error: VALUE_TOO_LONG,
  },
];

/**
 * A character that is one code point and two UTF-16 code units, so a limit counted with
 * `String.prototype.length` refuses at half the length the contract allows.
 */
const ASTRAL_CHARACTER = '𝄞';

/** One astral code point past the name and the value maximum, entered into the add row. */
const astralOverLimits: Array<{ desc: string; name: string; values: string; error: string }> = [
  {
    desc: 'the name is one astral code point over the limit',
    name: ASTRAL_CHARACTER.repeat(MAX_VARIABLE_NAME_LENGTH + 1),
    values: 'a',
    error: NAME_TOO_LONG,
  },
  {
    desc: 'a value is one astral code point over the limit',
    name: 'host',
    values: ASTRAL_CHARACTER.repeat(MAX_VARIABLE_VALUE_LENGTH + 1),
    error: VALUE_TOO_LONG,
  },
];

/** Stored maps the editor cannot render, one per maximum they exceed. */
const unrenderableMaps: Array<{ desc: string; variables: Record<string, string[]> }> = [
  { desc: 'more variables than the limit', variables: manyVariables(MAX_VARIABLES_PER_ITEM + 1) },
  { desc: 'a name longer than the limit', variables: { ['n'.repeat(MAX_VARIABLE_NAME_LENGTH + 1)]: ['a'] } },
  {
    desc: 'more values than the limit',
    variables: { host: Array.from({ length: MAX_VALUES_PER_VARIABLE + 1 }, (_, index) => `v${index}`) },
  },
  { desc: 'a value longer than the limit', variables: { host: ['v'.repeat(MAX_VARIABLE_VALUE_LENGTH + 1)] } },
];

const rejectedEdits: Array<{ desc: string; field: 'name' | 'values'; text: string; error: string }> = [
  { desc: 'its name is replaced with spaces', field: 'name', text: '   ', error: NAME_REQUIRED },
  { desc: 'its values are replaced with separators', field: 'values', text: ' , ', error: VALUE_REQUIRED },
];

const renames: Array<{ desc: string; newVariableName: string; expected: Record<string, string[]> }> = [
  {
    desc: 'to an unused name moves its values to the new name and leaves the other variables alone',
    newVariableName: 'cluster',
    expected: { cluster: ['a', 'b'], region: ['eu'] },
  },
  {
    desc: 'to its own name keeps it unchanged instead of reporting a duplicate',
    newVariableName: 'host',
    expected: { host: ['a', 'b'], region: ['eu'] },
  },
  {
    desc: 'to a name padded with spaces stores the trimmed name',
    newVariableName: '  cluster  ',
    expected: { cluster: ['a', 'b'], region: ['eu'] },
  },
];

const enterCommits: Array<{
  desc: string;
  field: 'name' | 'values';
  text: string;
  expected: Record<string, string[]>;
}> = [
  { desc: 'name', field: 'name', text: 'cluster', expected: { cluster: ['a', 'b'], region: ['eu'] } },
  { desc: 'values', field: 'values', text: 'x', expected: { host: ['x'], region: ['eu'] } },
];

describe('PlaylistItemVariables', () => {
  it('calls onChange with the comma-separated values split into a list when the add button is clicked', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables onChange={onChange} />);

    await user.type(newName(), 'host');
    await user.type(newValues(), 'a, b');
    await user.click(addButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['a', 'b'] });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('trims the spaces around a new variable name and around each of its values', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables onChange={onChange} />);

    await user.type(newName(), '  host  ');
    await user.type(newValues(), '  a ,  b  ');
    await user.click(addButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['a', 'b'] });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the variables already on the item when another one is added', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ region: ['eu'] }} onChange={onChange} />);

    await user.type(newName(), 'host');
    await user.type(newValues(), 'a, b');
    await user.click(addButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ region: ['eu'], host: ['a', 'b'] });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('commits the new variable on Enter in the values input without submitting the surrounding form', async () => {
    const onChange = jest.fn();
    const submitSpy = jest.fn();
    // The playlist form this editor renders inside carries a Save submit control, so this harness
    // carries one too and Enter here runs the same risk it runs in production.
    const { user } = setup(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitSpy();
        }}
      >
        <PlaylistItemVariables onChange={onChange} />
        <button type="submit">Save</button>
      </form>
    );

    await user.type(newName(), 'host');
    await user.type(newValues(), 'a, b');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['a', 'b'] });
    });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it.each(enterCommits)(
    'commits an existing row on Enter in its $desc input without submitting the surrounding form',
    async ({ field, text, expected }) => {
      const onChange = jest.fn();
      const submitSpy = jest.fn();
      const { user } = setup(
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitSpy();
          }}
        >
          <PlaylistItemVariables variables={{ host: ['a', 'b'], region: ['eu'] }} onChange={onChange} />
          <button type="submit">Save</button>
        </form>
      );

      const input = field === 'name' ? rowName('host') : rowValues('host');
      await user.clear(input);
      await user.type(input, text);
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(expected);
      });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(submitSpy).not.toHaveBeenCalled();
    }
  );

  it('commits an edited row once and returns its inputs to the stored values, however often the row is committed again', async () => {
    const onChange = jest.fn();
    const { user } = setup(
      <PlaylistItemVariables variables={{ host: ['a', 'b'], region: ['eu'] }} onChange={onChange} />
    );

    await user.clear(rowValues('host'));
    await user.type(rowValues('host'), 'x');
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    await user.tab();

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['x'], region: ['eu'] });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(rowValues('host')).toHaveValue('a, b');
  });

  it('does not call onChange when a row is focused and left without an edit', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ host: ['a', 'b'] }} onChange={onChange} />);

    await user.click(rowValues('host'));
    await user.tab();
    await user.click(rowName('host'));
    await user.tab();

    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(rejectedAdditions)(
    'shows "$error" and does not call onChange when $desc',
    async ({ variables, name, values, error }) => {
      const onChange = jest.fn();
      const { user } = setup(<PlaylistItemVariables variables={variables} onChange={onChange} />);

      if (name) {
        await user.type(newName(), name);
      }
      if (values) {
        await user.type(newValues(), values);
      }
      await user.click(addButton());

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(error);
      });
      expect(onChange).not.toHaveBeenCalled();
    }
  );

  it.each(rejectedEdits)(
    'shows "$error" and does not call onChange when an existing row is committed after $desc',
    async ({ field, text, error }) => {
      const onChange = jest.fn();
      const { user } = setup(<PlaylistItemVariables variables={{ host: ['a', 'b'] }} onChange={onChange} />);

      const input = field === 'name' ? rowName('host') : rowValues('host');
      await user.clear(input);
      await user.type(input, text);
      await user.tab();

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(error);
      });
      expect(onChange).not.toHaveBeenCalled();
    }
  );

  it.each(renames)('renaming a variable $desc', async ({ newVariableName, expected }) => {
    const onChange = jest.fn();
    const { user } = setup(
      <PlaylistItemVariables variables={{ host: ['a', 'b'], region: ['eu'] }} onChange={onChange} />
    );

    await user.clear(rowName('host'));
    await user.type(rowName('host'), newVariableName);
    await user.tab();

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(expected);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows the duplicate error and does not call onChange when a variable is renamed onto another variable name', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ host: ['a'], cluster: ['c'] }} onChange={onChange} />);

    await user.clear(rowName('host'));
    await user.type(rowName('host'), 'cluster');
    await user.tab();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(DUPLICATE_NAME);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls onChange with trimmed values, empty ones dropped and the other variables kept when an existing row is edited', async () => {
    const onChange = jest.fn();
    const { user } = setup(
      <PlaylistItemVariables variables={{ host: ['a', 'b'], region: ['eu'] }} onChange={onChange} />
    );

    await user.clear(rowValues('host'));
    await user.type(rowValues('host'), 'x, , y');
    await user.tab();

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['x', 'y'], region: ['eu'] });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('calls onChange with undefined when the only variable is removed', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ host: ['a', 'b'] }} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Remove variable host' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(undefined);
    });
  });

  it('calls onChange with the remaining variables when one of several is removed', async () => {
    const onChange = jest.fn();
    const { user } = setup(
      <PlaylistItemVariables variables={{ host: ['a', 'b'], region: ['eu'] }} onChange={onChange} />
    );

    await user.click(screen.getByRole('button', { name: 'Remove variable host' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ region: ['eu'] });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('carries an edit to one row and a rename of another through the parent without losing either', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['a'], region: ['eu'] }} onChange={onChange} />);

    await user.type(rowValues('region'), ', extra');
    // Reaching for the other row commits this one, the way leaving any field does.
    await user.clear(rowName('host'));
    await user.type(rowName('host'), 'cluster');
    await user.tab();

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({ cluster: ['a'], region: ['eu', 'extra'] });
    });
    expect(onChange).toHaveBeenNthCalledWith(1, { host: ['a'], region: ['eu', 'extra'] });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(rowValues('region')).toHaveValue('eu, extra');
    expect(rowName('cluster')).toHaveValue('cluster');
  });

  it('keeps one row uncommitted text when the item comes back with another variable added', async () => {
    const onChange = jest.fn();
    const { user, rerender } = setup(
      <PlaylistItemVariables variables={{ host: ['a'], region: ['eu'] }} onChange={onChange} />
    );

    await user.type(rowValues('region'), ', extra');

    rerender(<PlaylistItemVariables variables={{ host: ['a'], region: ['eu'], zone: ['z'] }} onChange={onChange} />);

    expect(rowValues('region')).toHaveValue('eu, extra');
    expect(rowValues('host')).toHaveValue('a');
    expect(rowValues('zone')).toHaveValue('z');
  });

  it('keeps a rejected row error and text when a different variable is removed', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['a'], region: ['eu'] }} onChange={onChange} />);

    await user.clear(rowName('region'));
    // Removing another row blurs this one, which rejects it and then changes the committed names.
    await user.click(screen.getByRole('button', { name: 'Remove variable host' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ region: ['eu'] });
    });
    expect(screen.getByRole('alert')).toHaveTextContent(NAME_REQUIRED);
    expect(rowName('region')).toHaveValue('');
  });

  it('shows the stored values of variables named after Object prototype members and commits an edit to one of them', async () => {
    const { onChange, emitted } = changeSpy();
    const { user } = setup(
      <PlaylistItemVariables
        variables={variableMap([
          ['__proto__', ['p']],
          ['toString', ['t']],
          ['constructor', ['c']],
        ])}
        onChange={onChange}
      />
    );

    expect(rowName('toString')).toHaveValue('toString');
    expect(rowValues('toString')).toHaveValue('t');
    expect(rowValues('__proto__')).toHaveValue('p');
    expect(rowValues('constructor')).toHaveValue('c');

    await user.clear(rowValues('toString'));
    await user.type(rowValues('toString'), 't2');
    await user.tab();

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(Object.entries(emitted[0] ?? {})).toEqual([
      ['__proto__', ['p']],
      ['toString', ['t2']],
      ['constructor', ['c']],
    ]);
  });

  it('adds a variable named __proto__ as an own key of the emitted map', async () => {
    const { onChange, emitted } = changeSpy();
    const { user } = setup(<PlaylistItemVariables onChange={onChange} />);

    await user.type(newName(), '__proto__');
    await user.type(newValues(), 'p');
    await user.click(addButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(Object.entries(emitted[0] ?? {})).toEqual([['__proto__', ['p']]]);
  });

  it('keeps the missing-name error on the new row while its values are retyped, and clears it when the name is filled in', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables onChange={onChange} />);

    await user.type(newValues(), 'a');
    await user.click(addButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(NAME_REQUIRED);
    });

    await user.type(newValues(), ', b');
    expect(screen.getByRole('alert')).toHaveTextContent(NAME_REQUIRED);

    await user.type(newName(), 'host');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps an existing row duplicate-name error while its values are edited, and clears it when the name is edited', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ host: ['a'], cluster: ['c'] }} onChange={onChange} />);

    await user.clear(rowName('host'));
    await user.type(rowName('host'), 'cluster');
    await user.tab();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(DUPLICATE_NAME);
    });

    await user.type(rowValues('host'), ', b');
    expect(screen.getByRole('alert')).toHaveTextContent(DUPLICATE_NAME);

    await user.type(rowName('host'), '-2');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('drops an uncommitted draft when the item comes back with variable names that run together into the same text', async () => {
    const onChange = jest.fn();
    const { user, rerender } = setup(<PlaylistItemVariables variables={{ a: ['1'], b: ['2'] }} onChange={onChange} />);

    await user.type(rowValues('a'), ', edited');
    expect(rowValues('a')).toHaveValue('1, edited');

    rerender(<PlaylistItemVariables variables={variableMap([['a\u0000b', ['3']]])} onChange={onChange} />);
    expect(screen.queryByRole('textbox', { name: 'Values for a' })).not.toBeInTheDocument();

    rerender(<PlaylistItemVariables variables={{ a: ['1'], b: ['2'] }} onChange={onChange} />);
    expect(rowValues('a')).toHaveValue('1');
  });

  it('accepts a name, a value count and a value length that sit exactly on their limits', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables onChange={onChange} />);

    const name = 'n'.repeat(MAX_VARIABLE_NAME_LENGTH);
    const values = [
      ...Array.from({ length: MAX_VALUES_PER_VARIABLE - 1 }, (_, index) => `v${index}`),
      'v'.repeat(MAX_VARIABLE_VALUE_LENGTH),
    ];

    setInputText(newName(), name);
    setInputText(newValues(), values.join(', '));
    await user.click(addButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ [name]: values });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('accepts a name and a value of exactly the limit in astral code points', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables onChange={onChange} />);

    // Twice as many UTF-16 code units as the limit allows, and exactly as many code points as it
    // allows, which is the unit the schema and the API state it in. The text is committed the way
    // a paste is, because the inputs' own `maxLength` counts the code units.
    const name = ASTRAL_CHARACTER.repeat(MAX_VARIABLE_NAME_LENGTH);
    const value = ASTRAL_CHARACTER.repeat(MAX_VARIABLE_VALUE_LENGTH);

    setInputText(newName(), name);
    setInputText(newValues(), value);
    await user.click(addButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ [name]: [value] });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each(astralOverLimits)('shows "$error" and does not call onChange when $desc', async ({ name, values, error }) => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables onChange={onChange} />);

    setInputText(newName(), name);
    setInputText(newValues(), values);
    await user.click(addButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(error);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the name error and does not call onChange when an existing row is renamed one astral code point over the limit', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ host: ['a'] }} onChange={onChange} />);

    await user.click(rowName('host'));
    setInputText(rowName('host'), ASTRAL_CHARACTER.repeat(MAX_VARIABLE_NAME_LENGTH + 1));
    await user.tab();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(NAME_TOO_LONG);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('bounds the text its inputs accept well above the name and value limits, so the limits are what refuse it', () => {
    render(<PlaylistItemVariables variables={{ host: ['a'] }} onChange={jest.fn()} />);

    // Both bounds are typing bounds on one control, deliberately larger than the limit that
    // decides acceptance: a bound equal to the limit makes the browser drop the excess in silence
    // and hands validation a name of exactly the limit, which it then accepts as though that were
    // what the user typed.
    expect(rowName('host')).toHaveAttribute('maxlength', String(MAX_VARIABLE_NAME_TEXT_LENGTH));
    expect(newName()).toHaveAttribute('maxlength', String(MAX_VARIABLE_NAME_TEXT_LENGTH));
    expect(MAX_VARIABLE_NAME_TEXT_LENGTH).toBeGreaterThan(2 * MAX_VARIABLE_NAME_LENGTH);
    // The values input holds a whole comma-separated list, so its bound is the list's, not one
    // value's, and it is sized so a full in-budget list can still be pasted.
    expect(rowValues('host')).toHaveAttribute('maxlength', String(MAX_VARIABLE_VALUES_TEXT_LENGTH));
    expect(newValues()).toHaveAttribute('maxlength', String(MAX_VARIABLE_VALUES_TEXT_LENGTH));
    expect(MAX_VARIABLE_VALUES_TEXT_LENGTH).toBeGreaterThan(2 * MAX_VARIABLE_VALUE_LENGTH);
  });

  it('keeps a pasted over-long name in the field and reports it rather than shortening it', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables onChange={onChange} />);

    // Pasted rather than set: a paste is subject to the input's own `maxLength`, so this is what
    // proves the browser no longer clips the name to the limit before validation sees it.
    const overLongName = 'b'.repeat(MAX_VARIABLE_NAME_LENGTH + 72);
    await user.click(newName());
    await user.paste(overLongName);
    await user.type(newValues(), 'ok2');

    expect(newName()).toHaveValue(overLongName);

    await user.click(addButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(NAME_TOO_LONG);
    });
    // The refused text stays in the field to be corrected, and nothing was added under a name the
    // user did not type.
    expect(newName()).toHaveValue(overLongName);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a pasted over-long rename of an existing row in the field and reports it', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ host: ['a'] }} onChange={onChange} />);

    const overLongName = 'b'.repeat(MAX_VARIABLE_NAME_LENGTH + 72);
    await user.clear(rowName('host'));
    await user.paste(overLongName);
    await user.tab();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(NAME_TOO_LONG);
    });
    expect(rowName('host')).toHaveValue(overLongName);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(rejectedLimits)('shows "$error" and does not call onChange when $desc', async ({ name, values, error }) => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables onChange={onChange} />);

    setInputText(newName(), name);
    setInputText(newValues(), values);
    await user.click(addButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(error);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the value-count error and does not call onChange when an existing row is given more values than the limit', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ host: ['a'] }} onChange={onChange} />);

    await user.click(rowValues('host'));
    setInputText(
      rowValues('host'),
      Array.from({ length: MAX_VALUES_PER_VARIABLE + 1 }, (_, index) => `v${index}`).join(',')
    );
    await user.tab();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(TOO_MANY_VALUES);
    });
    // The rejected text stays in the row for the user to correct, exactly as the other rejections
    // leave it, and the playlist item itself is untouched.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders an item holding the maximum number of variables and refuses to add one more', async () => {
    const onChange = jest.fn();
    const { user } = setup(
      <PlaylistItemVariables variables={manyVariables(MAX_VARIABLES_PER_ITEM)} onChange={onChange} />
    );

    // Two inputs per row, plus the two of the add row.
    expect(screen.getAllByRole('textbox')).toHaveLength(2 * MAX_VARIABLES_PER_ITEM + 2);

    await user.type(newName(), 'extra');
    await user.type(newValues(), 'v');
    await user.click(addButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(TOO_MANY_VARIABLES);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('introduces the add row with its own caption while keeping both of its fields reachable by their labels', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ host: ['a'] }} onChange={onChange} />);

    // The caption is what tells the two visible labels below it apart from the committed row
    // above, whose inputs are named by `aria-label` alone.
    expect(screen.getByText('Add a variable')).toBeInTheDocument();
    // It is styled as a caption rather than marked up as one: this editor renders inside the
    // row's `role="region"` panel, so a heading here would enter the page's heading outline.
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    // It names nothing: the add row's fields still resolve through their own labels, the committed
    // row through its aria-labels, and the add button through its own text.
    expect(newName()).toBeInTheDocument();
    expect(newValues()).toBeInTheDocument();
    expect(rowName('host')).toHaveValue('host');
    expect(rowValues('host')).toHaveValue('a');
    expect(addButton()).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(4);

    // The caption is decoration, so it must not have displaced the add row's own behaviour.
    await user.type(newName(), 'cluster');
    await user.type(newValues(), 'c');
    await user.click(addButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['a'], cluster: ['c'] });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows the add row caption on an item that holds no variables yet', () => {
    setup(<PlaylistItemVariables onChange={jest.fn()} />);

    expect(screen.getByText('Add a variable')).toBeInTheDocument();
    expect(newName()).toBeInTheDocument();
    expect(newValues()).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });

  it('adds the variable in the add row when focus leaves the row', async () => {
    const onChange = jest.fn();
    const { user } = setup(
      <>
        <PlaylistItemVariables onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>
    );

    await user.type(newName(), 'draft1');
    await user.type(newValues(), 'd1');
    // Collapsing the panel, deleting a row and saving the playlist all begin by moving focus out
    // of this row, and each of them would otherwise discard what is in it without a word.
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ draft1: ['d1'] });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not add anything or report anything when focus moves between the add row controls', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables onChange={onChange} />);

    await user.type(newName(), 'host');
    // Name to values to the add button and back: the row is being filled in, not left.
    await user.click(newValues());
    await user.type(newValues(), 'a');
    await user.click(newName());

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(addButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['a'] });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('leaves an untouched add row without adding anything and without a message', async () => {
    const onChange = jest.fn();
    const { user } = setup(
      <>
        <PlaylistItemVariables variables={{ host: ['a'] }} onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>
    );

    await user.click(newName());
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a half-filled add row when focus leaves it instead of dropping the text', async () => {
    const onChange = jest.fn();
    const { user } = setup(
      <>
        <PlaylistItemVariables onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>
    );

    await user.type(newName(), 'draft1');
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(VALUE_REQUIRED);
    });
    expect(newName()).toHaveValue('draft1');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says while the add row is being typed into that its variable is not part of the item yet', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables onChange={onChange} />);

    expect(screen.queryByText(PENDING_HINT)).not.toBeInTheDocument();

    await user.type(newName(), 'host');
    expect(screen.getByText(PENDING_HINT)).toBeInTheDocument();
    // It is a note, not a rejection: nothing here has been refused.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.type(newValues(), 'a');
    await user.click(addButton());

    await waitFor(() => {
      expect(screen.queryByText(PENDING_HINT)).not.toBeInTheDocument();
    });
    expect(onChange).toHaveBeenCalledWith({ host: ['a'] });
  });

  it('adds the text still in the add row when the form settles, and lets the form go on', async () => {
    const onChange = jest.fn();
    const onSettle = jest.fn();
    const { user } = setup(<SettleHarness onChange={onChange} onSettle={onSettle} />);

    await user.type(newName(), 'draft2');
    await user.type(newValues(), 'd2');
    // Clicked without moving focus, which is how a submit can reach the form while a field is
    // still being edited.
    fireEvent.click(settleButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ draft2: ['d2'] });
    });
    expect(onSettle).toHaveBeenCalledWith(true);
    expect(newName()).toHaveValue('');
    expect(newValues()).toHaveValue('');
  });

  it('refuses the form when the add row cannot be added, and shows why', async () => {
    const onChange = jest.fn();
    const onSettle = jest.fn();
    const { user } = setup(<SettleHarness onChange={onChange} onSettle={onSettle} />);

    await user.type(newValues(), 'Host9');
    fireEvent.click(settleButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(NAME_REQUIRED);
    });
    expect(onSettle).toHaveBeenCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(newValues()).toHaveValue('Host9');
  });

  it('refuses the form while an existing row holds an invalid edit, and lets it through once corrected', async () => {
    const onChange = jest.fn();
    const onSettle = jest.fn();
    const { user } = setup(<SettleHarness initial={{ keep: ['k1'] }} onChange={onChange} onSettle={onSettle} />);

    await user.clear(rowValues('keep'));
    fireEvent.click(settleButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(VALUE_REQUIRED);
    });
    expect(onSettle).toHaveBeenLastCalledWith(false);
    // The stored value is untouched: refusing the edit must not save the value it replaced either.
    expect(onChange).not.toHaveBeenCalled();

    await user.type(rowValues('keep'), 'k9');
    fireEvent.click(settleButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ keep: ['k9'] });
    });
    expect(onSettle).toHaveBeenLastCalledWith(true);
  });

  it('keeps every pending row edit when the form settles them together', async () => {
    const onChange = jest.fn();
    const onSettle = jest.fn();
    setup(<SettleHarness initial={{ host: ['a'], region: ['eu'] }} onChange={onChange} onSettle={onSettle} />);

    // Two rows edited without either being left, so both are still pending when the form settles.
    // Committing them one at a time would rebuild the item from the same starting point twice and
    // leave only the last edit standing.
    fireEvent.change(rowValues('host'), { target: { value: 'a, b' } });
    fireEvent.change(rowValues('region'), { target: { value: 'eu, us' } });
    fireEvent.click(settleButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['a', 'b'], region: ['eu', 'us'] });
    });
    expect(onSettle).toHaveBeenCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not refuse the form for a message left on an add row that is now empty', async () => {
    const onChange = jest.fn();
    const onSettle = jest.fn();
    const { user } = setup(<SettleHarness initial={{ host: ['a'] }} onChange={onChange} onSettle={onSettle} />);

    // Enter on an empty add row reports the missing name; that message must not then refuse every
    // save, since an empty row leaves the user nothing to correct.
    await user.click(newValues());
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(NAME_REQUIRED);
    });

    fireEvent.click(settleButton());

    await waitFor(() => {
      expect(onSettle).toHaveBeenCalledWith(true);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops refusing the form once the editor that refused it has been collapsed away', async () => {
    const onChange = jest.fn();
    const onSettle = jest.fn();
    const { user } = setup(<CollapsibleSettleHarness onChange={onChange} onSettle={onSettle} />);

    await user.type(newValues(), 'Host9');
    fireEvent.click(settleButton());
    await waitFor(() => {
      expect(onSettle).toHaveBeenLastCalledWith(false);
    });

    // Collapsing takes the editor away, and with it the text it could not add. A save after that
    // has nothing left to settle, so it must go through rather than stay refused forever.
    await user.click(screen.getByRole('button', { name: 'Collapse' }));
    fireEvent.click(settleButton());

    await waitFor(() => {
      expect(onSettle).toHaveBeenLastCalledWith(true);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps what the other open editor was holding when one of them refuses the form', async () => {
    const onFirstChange = jest.fn();
    const onSecondChange = jest.fn();
    const onSettle = jest.fn();
    const { user } = setup(
      <TwoEditorSettleHarness onFirstChange={onFirstChange} onSecondChange={onSecondChange} onSettle={onSettle} />
    );

    const first = within(screen.getByRole('group', { name: 'First item' }));
    const second = within(screen.getByRole('group', { name: 'Second item' }));

    // The first editor cannot be settled; the second one can. A save must learn that it was
    // refused without the refusal costing the second editor the text it was holding.
    await user.type(first.getByRole('textbox', { name: 'Values (comma-separated)' }), 'Host9');
    await user.type(second.getByRole('textbox', { name: 'Variable name' }), 'cluster');
    await user.type(second.getByRole('textbox', { name: 'Values (comma-separated)' }), 'c1');
    fireEvent.click(settleButton());

    await waitFor(() => {
      expect(onSettle).toHaveBeenCalledWith(false);
    });
    expect(first.getByRole('alert')).toHaveTextContent(NAME_REQUIRED);
    expect(onFirstChange).not.toHaveBeenCalled();
    expect(onSecondChange).toHaveBeenCalledWith({ cluster: ['c1'] });
    // Nothing is lost while the first editor is corrected: the text is still where the user left it.
    expect(first.getByRole('textbox', { name: 'Values (comma-separated)' })).toHaveValue('Host9');
  });

  it('shows the rows in name order whatever order the stored map arrives in', () => {
    const { rerender } = setup(
      <PlaylistItemVariables variables={{ host: ['Host1'], cluster: ['c1'], anchor: ['a1'] }} onChange={jest.fn()} />
    );

    // The map keeps insertion order until it is saved and comes back in key order, so the order it
    // arrives in is not something the user can rely on. The rows are ordered here instead.
    expect(renderedRowNames()).toEqual(['anchor', 'cluster', 'host']);

    rerender(
      <PlaylistItemVariables variables={{ anchor: ['a1'], cluster: ['c1'], host: ['Host1'] }} onChange={jest.fn()} />
    );

    expect(renderedRowNames()).toEqual(['anchor', 'cluster', 'host']);
  });

  it('puts a newly added variable straight into its place in that order', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['Host1'] }} onChange={onChange} />);

    await user.type(newName(), 'cluster');
    await user.type(newValues(), 'c1, c2');
    await user.click(addButton());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['Host1'], cluster: ['c1', 'c2'] });
    });
    // Where the name sorts, not where it was added: the order the user sees before saving is then
    // the order they see after a save and a reload.
    expect(renderedRowNames()).toEqual(['cluster', 'host']);
  });

  it('gives the values column a larger share of the row than the name column', () => {
    setup(<PlaylistItemVariables variables={{ host: ['a', 'b'] }} onChange={jest.fn()} />);

    const tracks = window.getComputedStyle(gridContainerOf(rowName('host'))).gridTemplateColumns;
    expect(tracks).toBe('minmax(0, 2fr) minmax(0, 3fr) auto');

    // The literal above pins the rule; this is what the layout actually depends on. The name
    // field holds one identifier and the values field beside it holds a whole comma-separated
    // list, so an even split scrolls the tail of an ordinary list out of the values field while
    // half the name field stays empty. The values track has to be the wider of the two.
    const [nameFraction, valuesFraction] = fractionTracks(tracks);
    expect(nameFraction).toBeGreaterThan(0);
    expect(valuesFraction).toBeGreaterThan(nameFraction);
  });

  it('separates consecutive variables further than a variable is separated from its own values in the stacked layout', () => {
    setup(<PlaylistItemVariables variables={{ host: ['a', 'b'] }} onChange={jest.fn()} />);

    const grid = gridContainerOf(rowName('host'));
    const valuesCell = gridItemOf(grid, rowValues('host'));
    const removeCell = gridItemOf(grid, screen.getByRole('button', { name: 'Remove variable host' }));

    // Stacked, a variable's name takes a line of its own and its values the next one, so the only
    // thing saying which values belong to which name is that the distance inside a variable is
    // smaller than the distance to the variable after it. The stacked layout's own row gap is the
    // distance inside a variable; without one it is whatever the grid's `gap` leaves, which is the
    // flat rhythm the finding is about.
    const gridGaps = window.getComputedStyle(grid);
    const insideVariable =
      mobilePixels(grid, 'row-gap') || Number.parseFloat(gridGaps.rowGap || gridGaps.gap || '0') || 0;
    const closingMargin = mobilePixels(valuesCell, 'margin-block-end');
    const betweenVariables = insideVariable + closingMargin;

    expect(insideVariable).toBeGreaterThan(0);
    expect(betweenVariables).toBeGreaterThanOrEqual(2 * insideVariable);
    // A grid track is as tall as the tallest margin box in it, so the remove button sharing the
    // values row has to close the variable by the same amount; otherwise the gap would depend on
    // which of the two cells happened to be taller.
    expect(mobilePixels(removeCell, 'margin-block-end')).toBe(closingMargin);
    // The add row keeps the spacing it has: its caption and the rule above it already separate it
    // from the last committed variable.
    expect(mobilePixels(gridItemOf(grid, newValues()), 'margin-block-end')).toBe(0);
  });

  it.each(unrenderableMaps)(
    'renders one fixed message and no rows when the stored variables hold $desc',
    ({ variables }) => {
      const onChange = jest.fn();
      render(<PlaylistItemVariables variables={variables} onChange={onChange} />);

      expect(screen.getByRole('alert')).toHaveTextContent(NOT_EDITABLE);
      expect(screen.queryAllByRole('textbox')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Add variable' })).not.toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    }
  );

  /*
   * Focus. An existing row is keyed by its variable name, so committing a rename replaces the whole
   * row and removing a row unmounts it — in both cases taking the element the user was working in
   * with it, which leaves focus on the document body. Every test below goes through
   * `ControlledEditor`, because focus is only lost once the caller applies what the editor emits.
   */

  it('keeps focus on the renamed row name input when a rename is committed with Enter', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['a'], region: ['eu'] }} onChange={onChange} />);

    await user.clear(rowName('host'));
    await user.type(rowName('host'), 'host9');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host9: ['a'], region: ['eu'] });
    });
    // Enter commits without moving focus, so the renamed row's own name input is where the user
    // still is — not the document body the replaced input left focus on.
    expect(rowName('host9')).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('moves focus to the renamed row values input when the rename is committed by tabbing into it', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['a'], region: ['eu'] }} onChange={onChange} />);

    await user.clear(rowName('host'));
    await user.type(rowName('host'), 'host9');
    // Tab commits the row on blur, and the row it replaces holds the field being tabbed into.
    await user.tab();

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host9: ['a'], region: ['eu'] });
    });
    expect(rowValues('host9')).toHaveFocus();
  });

  it('leaves focus on the add row name input when a rename is committed by moving to it', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['a'] }} onChange={onChange} />);

    await user.clear(rowName('host'));
    await user.type(rowName('host'), 'host9');
    await user.click(newName());

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host9: ['a'] });
    });
    // The add row survives the replacement, so the row must not pull focus back out of it.
    expect(newName()).toHaveFocus();
  });

  it('leaves focus in the row name input when a rename is rejected', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['a'], region: ['eu'] }} onChange={onChange} />);

    await user.clear(rowName('host'));
    await user.type(rowName('host'), 'region');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(DUPLICATE_NAME);
    });
    expect(onChange).not.toHaveBeenCalled();
    // Nothing was replaced, so nothing may be focused on the row's behalf.
    expect(rowName('host')).toHaveFocus();
  });

  it('keeps focus in the row values input when a commit changes only the values', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['a'], region: ['eu'] }} onChange={onChange} />);

    await user.clear(rowValues('host'));
    await user.type(rowValues('host'), 'x');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['x'], region: ['eu'] });
    });
    // The row keeps its name and so its identity: the input the user is in is the same element.
    expect(rowValues('host')).toHaveFocus();
  });

  it('moves focus to the next row remove button when a variable between two others is removed', async () => {
    const onChange = jest.fn();
    const { user } = setup(
      <ControlledEditor initial={{ host: ['a'], cluster: ['c'], region: ['eu'] }} onChange={onChange} />
    );

    await user.click(removeButton('cluster'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['a'], region: ['eu'] });
    });
    // The next row takes the removed one's place on screen, so its remove button takes the focus.
    expect(removeButton('region')).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('moves focus to the previous row remove button when the last variable is removed', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['a'], region: ['eu'] }} onChange={onChange} />);

    await user.click(removeButton('region'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['a'] });
    });
    expect(removeButton('host')).toHaveFocus();
  });

  it('moves focus to the add row name input when the only variable is removed', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['a'] }} onChange={onChange} />);

    await user.click(removeButton('host'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(undefined);
    });
    // No row survives, so the only control left that the removal did not destroy takes the focus.
    expect(newName()).toHaveFocus();
  });

  it('moves focus to the next row remove button when a variable is removed with the keyboard', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['a'], region: ['eu'] }} onChange={onChange} />);

    await user.click(rowValues('host'));
    await user.tab();
    expect(removeButton('host')).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ region: ['eu'] });
    });
    expect(removeButton('region')).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('leaves the focused input of another row focused when a variable is removed', async () => {
    const onChange = jest.fn();
    const { user } = setup(<ControlledEditor initial={{ host: ['a'], region: ['eu'] }} onChange={onChange} />);

    await user.click(rowValues('region'));
    // Fired rather than clicked, because a real pointer would have taken focus to the button first:
    // this is the case where the activation left focus somewhere the removal does not destroy.
    fireEvent.click(removeButton('host'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ region: ['eu'] });
    });
    // Keying the rows by name is what preserves this input's element, and nothing may move the
    // caret out of it: the user is typing there, not operating the row that was removed.
    expect(rowValues('region')).toHaveFocus();
  });

  /**
   * A variable name is free text the user typed, and these three controls are the only place in the
   * playlist editor that interpolates such text into an `aria-label` or a `tooltip`. Both are
   * text-only sinks — React sets an attribute value and renders a text node, neither of which is
   * ever parsed as HTML — so the name has to reach them as the characters that were typed. i18next
   * escapes interpolated values for HTML by default, which would name the control after the entity
   * spelling of the name (`Variable name for it&#39;s`) while the input beside it shows the real
   * one, leaving the accessible name and the visible value disagreeing.
   */
  describe('accessible names of the per-variable controls', () => {
    /** Every entity an HTML escaper produces, so a re-escaped name is caught whichever it emits. */
    const HTML_ENTITY = /&(?:amp|lt|gt|quot|#39|#x2F|#47);/;

    const escapableNames: Array<{ desc: string; name: string; values: string[] }> = [
      { desc: 'an apostrophe alone', name: "it's", values: ['x'] },
      { desc: 'every escaped character at once', name: 'a&b\'c<d>e"f/g', values: ['x'] },
      {
        desc: 'URL metacharacters',
        name: 'a&b=c?d#e f/g',
        values: ['x&y', 'p=q', 'r?s', 't#u', 'v w', 'y/z'],
      },
      { desc: 'a script tag', name: "<script>alert('xss1')</script>", values: ['x'] },
      { desc: 'an image tag with an event handler', name: '<img src=x onerror=alert(1)>', values: ['x'] },
    ];

    it.each(escapableNames)(
      'names both inputs and the remove button after a name holding $desc',
      ({ name, values }) => {
        render(<PlaylistItemVariables variables={variableMap([[name, values]])} onChange={jest.fn()} />);

        // Queried by role and accessible name, which is the computed name assistive technology
        // announces rather than the raw attribute — the two differ precisely when the label is
        // escaped, so resolving these is the assertion.
        const nameInput = rowName(name);
        const valuesInput = rowValues(name);
        const remove = screen.getByRole('button', { name: `Remove variable ${name}` });

        // The same strings read straight off the DOM, so a failure names the attribute that is wrong.
        expect(nameInput).toHaveAttribute('aria-label', `Variable name for ${name}`);
        expect(valuesInput).toHaveAttribute('aria-label', `Values for ${name}`);
        for (const label of [nameInput.getAttribute('aria-label'), valuesInput.getAttribute('aria-label')]) {
          expect(label).not.toMatch(HTML_ENTITY);
        }
        expect(remove).toBeInTheDocument();

        // The visible value and the accessible name have to be the same characters; that they agree
        // is the defect's absence, and asserting the value alone never showed it.
        expect(nameInput).toHaveValue(name);
        expect(valuesInput).toHaveValue(values.join(', '));
      }
    );

    it('names the controls of a variable added through the editor after the name as typed', async () => {
      const name = 'a&b\'c<d>e"f/g';
      const { onChange } = changeSpy();
      const { user } = setup(<ControlledEditor initial={{}} onChange={onChange} />);

      await user.type(newName(), name);
      await user.type(newValues(), 'x');
      await user.click(addButton());

      // The map is emitted with the typed name, so any escaping is presentation and not storage.
      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith({ [name]: ['x'] });
      });
      expect(rowName(name)).toHaveValue(name);
      expect(screen.getByRole('button', { name: `Remove variable ${name}` })).toBeInTheDocument();
    });

    it('renders a script or image tag in a variable name as text and never as an element', () => {
      const { container } = render(
        <PlaylistItemVariables
          variables={variableMap([
            ["<script>alert('xss1')</script>", ['x']],
            ['<img src=x onerror=alert(1)>', ['y']],
          ])}
          onChange={jest.fn()}
        />
      );

      // Naming a control after untrusted text without escaping it is only safe because the sink is
      // an attribute value and a text node. This is that guarantee, asserted rather than assumed:
      // no markup in a name may become an element, whatever the interpolation does with it.
      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.querySelectorAll('img')).toHaveLength(0);
    });
  });
});
