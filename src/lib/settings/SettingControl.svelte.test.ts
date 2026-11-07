import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./store.svelte', () => ({
  getSettingValue: vi.fn(() => 'self-hosted'),
  isModified: vi.fn(() => true),
  isPending: vi.fn(() => false),
  setSettingValue: vi.fn(() => Promise.resolve()),
  resetSettingValue: vi.fn(() => Promise.resolve())
}));
vi.mock('$lib/api/auth.svelte', () => ({ authSession: { current: null } }));
vi.mock('./registry.svelte', () => ({
  CUSTOM_COMPONENT_LOADERS: {},
  INFO_VALUES: {},
  SETTING_ACTIONS: {},
  SETTING_OPTION_FILTERS: {}
}));
// bits-ui's select does not compile in this test environment, and the
// rows under test are radio buttons that never render it.
vi.mock('./SettingSelect.svelte', () => ({ default: () => {} }));
vi.mock('./pickers.svelte', () => ({
  folderOptions: () => [],
  tagOptions: () => []
}));
vi.mock('./i18n.svelte', () => ({
  tLabel: (_ns: string, id: string) => id,
  tDescription: () => '',
  tUi: (key: string) => key,
  tValue: (_id: string, value: string) => value
}));

import SettingControl from './SettingControl.svelte';
import type { Setting } from './types';

const serverType = {
  id: 'account.serverType',
  scope: 'V',
  type: 'radio',
  default: 'local-only',
  options: ['managed', 'self-hosted', 'local-only']
} as Setting;

afterEach(cleanup);

describe('SettingControl', () => {
  it('offers to reset a changed setting', () => {
    const { queryByRole, queryByLabelText } = render(SettingControl, {
      setting: serverType
    });
    expect(queryByRole('button', { name: 'reset' })).not.toBeNull();
    expect(queryByLabelText('modified')).not.toBeNull();
  });

  it('shows no modified marker or reset for a setting without a default to return to', () => {
    const { queryByRole, queryByLabelText } = render(SettingControl, {
      setting: { ...serverType, resettable: false }
    });
    expect(queryByRole('button', { name: 'reset' })).toBeNull();
    expect(queryByLabelText('modified')).toBeNull();
  });
});
