<script lang="ts">
  /**
   * The devices signed in to the account, and signing them out.
   *
   * Signing a device out ends its session on the server. That device
   * notices within a second if it is online, shows that it was signed out,
   * and keeps its notes.
   */
  import {
    Loader2,
    LogOut,
    MonitorSmartphone,
    ShieldCheck
  } from '@lucide/svelte';
  import {
    accountEndOtherSessions,
    accountEndSession,
    accountSessions,
    type DeviceSession
  } from '$lib/api/account';
  import { Button } from '$lib/components/ui/button';
  import { i18n, tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  import { deviceLabel, formatDeviceTime, orderDevices } from './devices';
  import { describeRefusal } from './refusal';

  interface Props {
    /** Bumped by the parent when something else may have ended sessions:
     *  a new password, or a new authenticator. */
    revision: number;
  }

  let { revision }: Props = $props();

  let devices = $state<DeviceSession[] | null>(null);
  /** The id being signed out, or 'others' for all of them at once. */
  let ending = $state<number | 'others' | null>(null);
  let error = $state<string | null>(null);

  const others = $derived((devices ?? []).filter((device) => !device.current));

  async function load() {
    try {
      devices = orderDevices(await accountSessions());
      error = null;
    } catch (err) {
      error = describeRefusal(err);
    }
  }

  $effect(() => {
    // Read so the effect runs again when the parent bumps it.
    void revision;
    void load();
  });

  async function end(action: number | 'others') {
    if (ending !== null) return;
    ending = action;
    error = null;
    try {
      if (action === 'others') await accountEndOtherSessions();
      else await accountEndSession(action);
      await load();
    } catch (err) {
      error = describeRefusal(err);
    } finally {
      ending = null;
    }
  }
</script>

<div class="grid gap-2" data-testid="account-devices">
  <div>
    <div class="text-sm font-medium">{tUi('account.devices.title')}</div>
    <p class="text-xs text-muted-foreground">
      {tUi('account.devices.explanation')}
    </p>
  </div>

  {#if devices === null && !error}
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" />
      {tUi('account.security.loading')}
    </div>
  {:else if devices}
    <ul class="grid gap-1.5">
      {#each devices as device (device.id)}
        <li
          class="flex items-center gap-3 rounded-md border border-border bg-background/60 px-3 py-2"
          data-testid="account-device"
          data-current={device.current}
        >
          <MonitorSmartphone class="size-4 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="truncate text-sm">
                {deviceLabel(device.deviceName) ||
                  tUi('account.devices.unknown')}
              </span>
              {#if device.current}
                <span
                  class="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary"
                >
                  {tUi('account.devices.thisDevice')}
                </span>
              {/if}
              {#if device.secondFactor}
                <span
                  class="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
                  title={tUi('account.devices.secondFactor')}
                >
                  <ShieldCheck class="size-3" />
                  {tUi('account.devices.secondFactor')}
                </span>
              {/if}
            </div>
            <div class="text-xs text-muted-foreground">
              {tUiFormat('account.devices.times', {
                signedIn: formatDeviceTime(device.createdAt, i18n.language),
                lastUsed: formatDeviceTime(device.lastUsedAt, i18n.language)
              })}
            </div>
          </div>
          {#if !device.current}
            <Button
              size="sm"
              variant="ghost"
              onclick={() => end(device.id)}
              disabled={ending !== null}
              aria-label={tUiFormat('account.devices.signOutNamed', {
                device:
                  deviceLabel(device.deviceName) ||
                  tUi('account.devices.unknown')
              })}
            >
              <span class="inline-flex items-center">
                {#if ending === device.id}
                  <Loader2 class="mr-1.5 size-3.5 animate-spin" />
                {:else}
                  <LogOut class="mr-1.5 size-3.5" />
                {/if}
                {tUi('account.devices.signOut')}
              </span>
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if others.length > 1}
      <div>
        <Button
          size="sm"
          variant="secondary"
          onclick={() => end('others')}
          disabled={ending !== null}
        >
          <span class="inline-flex items-center">
            {#if ending === 'others'}
              <Loader2 class="mr-1.5 size-3.5 animate-spin" />
            {/if}
            {tUi('account.devices.signOutOthers')}
          </span>
        </Button>
      </div>
    {/if}
  {/if}
  {#if error}
    <p class="text-xs text-destructive">{error}</p>
  {/if}
</div>
