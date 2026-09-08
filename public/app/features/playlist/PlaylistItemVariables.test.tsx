import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { PlaylistItemVariables } from './PlaylistItemVariables';

const NAME_REQUIRED = 'Variable name is required';
const VALUE_REQUIRED = 'Variable value is required';
const DUPLICATE_NAME = 'A variable with this name already exists';

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

/** The name input of the row that adds a new variable, labelled instead of aria-labelled. */
function newName() {
  return screen.getByRole('textbox', { name: 'Variable name' });
}

/** The values input of the row that adds a new variable. */
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
    // The editor renders inside the playlist form in production. Enter on an input only reaches
    // the implicit submission path when the form holds a submit control, so this button is what
    // gives the "form was not submitted" assertion below its teeth.
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
});
