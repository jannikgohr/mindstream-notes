<script lang="ts">
  import { HOTKEY_PRESETS, hotkeyPreset } from '$lib/hotkeys/presets';
  import {
    setHotkeyPreset,
    HotkeyBindingConflictError
  } from '$lib/hotkeys/store.svelte';
  import { getSettingValue } from '../store.svelte';
  import { tUi, tUiFormat, tValue } from '../i18n.svelte';
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

<select
  aria-label={tUi('onboarding.shortcuts')}
  value={hotkeyPreset(getSettingValue('hotkeys.preset'))}
  disabled={busy}
  onchange={(event) => select(event.currentTarget.value)}
  class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
>
  {#each HOTKEY_PRESETS as preset (preset)}<option value={preset}
      >{tValue('hotkeys.preset', preset)}</option
    >{/each}
</select>
{#if error}<p class="mt-2 text-sm text-destructive" role="alert">
    {error}
  </p>{/if}
