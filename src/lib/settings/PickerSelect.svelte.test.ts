import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import PickerSelect from './PickerSelect.svelte';

describe('PickerSelect', () => {
  it('filters options and selects a result', async () => {
    const onChange = vi.fn();
    render(PickerSelect, {
      value: '',
      items: [
        { value: 'a', label: 'Archive' },
        { value: 'p', label: 'Projects' }
      ],
      unsetLabel: 'None',
      searchLabel: 'Search choices',
      emptyLabel: 'No matches',
      ariaLabel: 'Folder',
      onChange
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Folder' }));
    const search = screen.getByRole('textbox', { name: 'Search choices' });
    await fireEvent.input(search, { target: { value: 'proj' } });

    expect(screen.queryByText('Archive')).toBeNull();
    await fireEvent.click(screen.getByRole('option', { name: 'Projects' }));
    expect(onChange).toHaveBeenCalledWith('p');
  });
});
