import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  { desc: 'the values are left blank', name: 'host', values: '', error: VALUE_REQUIRED },
  {
    desc: 'the name is already used by another variable',
    variables: { host: ['a'] },
    name: 'host',
    values: 'b',
    error: DUPLICATE_NAME,
  },
];

const renames: Array<{ desc: string; newVariableName: string; expected: Record<string, string[]> }> = [
  {
    desc: 'to an unused name moves its values to the new name',
    newVariableName: 'cluster',
    expected: { cluster: ['a', 'b'] },
  },
  {
    desc: 'to its own name keeps it unchanged instead of reporting a duplicate',
    newVariableName: 'host',
    expected: { host: ['a', 'b'] },
  },
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

  it.each(renames)('renaming a variable $desc', async ({ newVariableName, expected }) => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ host: ['a', 'b'] }} onChange={onChange} />);

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

  it('calls onChange with trimmed values and empty ones dropped when an existing row is edited', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ host: ['a', 'b'] }} onChange={onChange} />);

    await user.clear(rowValues('host'));
    await user.type(rowValues('host'), 'x, , y');
    await user.tab();

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ host: ['x', 'y'] });
    });
  });

  it('calls onChange with undefined when the only variable is removed', async () => {
    const onChange = jest.fn();
    const { user } = setup(<PlaylistItemVariables variables={{ host: ['a', 'b'] }} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Remove variable host' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(undefined);
    });
  });
});
