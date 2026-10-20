<script lang="ts">
  import { HOTKEY_PRESETS, hotkeyPreset } from '$lib/hotkeys/presets';
  import {
    setHotkeyPreset,
    HotkeyBindingConflictError
  } from '$lib/hotkeys/store.svelte';
  import { getSettingValue } from '../store.svelte';
  import { tUi, tUiFormat } from '../i18n.svelte';
  import SettingSelect from '../SettingSelect.svelte';
  import { toErrorMessage } from '$lib/api/errors';

  let busy = $state(false);
  let error = $state('');
  async function select(value: string) {
    busy = true;
    error = '';
    try {
      await setHotkeyPreset(hotkeyPreset(value));
    } catch (cause) {
      error =
        cause instanceof HotkeyBindingConflictError
          ? tUiFormat('onboarding.shortcutConflict', { binding: cause.binding })
          : toErrorMessage(cause);
    } finally {
      busy = false;
    }
  }
</script>

<SettingSelect
  settingId="hotkeys.preset"
  ariaLabel={tUi('onboarding.shortcuts')}
  value={hotkeyPreset(getSettingValue('hotkeys.preset'))}
  options={[...HOTKEY_PRESETS]}
  disabled={busy}
  onChange={select}
  class="h-11 w-full px-3"
  touchFriendly
/>
{#if error}<p class="mt-2 text-sm text-destructive" role="alert">
    {error}
  </p>{/if}
