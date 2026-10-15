import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandErrorCode } from '$lib/api/core';
import ProofForm from './ProofForm.svelte';

afterEach(cleanup);

function show(
  needCode: boolean,
  onSubmit: (password: string, code: string) => Promise<void> = vi.fn(
    async () => {}
  )
) {
  const onCancel = vi.fn();
  render(ProofForm, {
    explanation: 'Enter your password.',
    needCode,
    submitLabel: 'Go on',
    onSubmit,
    onCancel
  });
  return { onSubmit, onCancel };
}

const submitButton = () =>
  screen.getByRole('button', { name: 'Go on' }) as HTMLButtonElement;

describe('ProofForm', () => {
  it('asks for the password alone where there is no second factor', async () => {
    const { onSubmit } = show(false);
    expect(screen.queryByLabelText('Code')).toBeNull();
    expect(submitButton().disabled).toBe(true);

    await fireEvent.input(screen.getByLabelText('Password'), {
      target: { value: 'hunter22' }
    });
    expect(submitButton().disabled).toBe(false);
    await fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledWith('hunter22', '');
  });

  it('wants a code too where there is one', async () => {
    const { onSubmit } = show(true);
    await fireEvent.input(screen.getByLabelText('Password'), {
      target: { value: 'hunter22' }
    });
    expect(submitButton().disabled).toBe(true);

    await fireEvent.input(screen.getByLabelText('Code'), {
      target: { value: ' 123456 ' }
    });
    await fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledWith('hunter22', '123456');
  });

  it('shows why the server refused, in the app language', async () => {
    const refuse = vi.fn(async () => {
      throw {
        code: CommandErrorCode.Refused,
        message: 'remove the authenticator: Wrong password for user.',
        reason: 'login_bad_signature'
      };
    });
    show(false, refuse);
    await fireEvent.input(screen.getByLabelText('Password'), {
      target: { value: 'not it' }
    });
    await fireEvent.click(submitButton());

    expect((await screen.findByTestId('account-proof-error')).textContent).toBe(
      'Wrong password.'
    );
    // And the form is usable again.
    expect(submitButton().disabled).toBe(false);
  });

  it('cancels without submitting', async () => {
    const { onSubmit, onCancel } = show(false);
    await fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
