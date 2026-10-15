<script lang="ts">
  /**
   * The invite links into a shared folder: the ones that exist, and making
   * a new one.
   *
   * A link's secret is in its text and nowhere else, so a new link is shown
   * here once, to be copied. The list below it shows how often each link
   * was used and lets one be removed. It cannot show a link again.
   */
  import { onMount } from 'svelte';
  import { Check, Copy, Link, Trash2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    createShareLink,
    listShareLinks,
    revokeShareLink,
    type ShareLink,
    type ShareLinkAccessLevel
  } from '$lib/api/sharing';
  import { describeRefusal } from '$lib/account/refusal';
  import { loadTree } from '$lib/stores/tree.svelte';
  import { i18n, tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  import { pushToast } from './toast.svelte';

  interface Props {
    collectionId: string;
    /** The server lets a link create an account for someone without one. */
    signupByLink?: boolean;
  }

  let { collectionId, signupByLink = false }: Props = $props();

  const PEOPLE = [1, 5, 25];
  const DAYS = [1, 7, 30];
  const FIELD_CLASS =
    'h-7 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

  let links = $state<ShareLink[]>([]);
  let loadFailed = $state(false);
  let accessLevel = $state<ShareLinkAccessLevel>('read_only');
  let people = $state(1);
  let days = $state(7);
  let allowSignup = $state(false);
  let pending = $state(false);
  let error = $state<string | null>(null);
  /** The link that was just made. Gone once the dialog closes. */
  let created = $state<string | null>(null);
  let copied = $state(false);
  let removing = $state<string | null>(null);

  function people_(count: number): string {
    return tUiFormat(
      count === 1 ? 'sharing.links.people.one' : 'sharing.links.people.other',
      { count }
    );
  }

  function days_(count: number): string {
    return tUiFormat(
      count === 1 ? 'sharing.links.days.one' : 'sharing.links.days.other',
      { count }
    );
  }

  function accessLabel(level: ShareLink['access_level']): string {
    return tUi(
      level === 'read_write'
        ? 'sharing.access.readWrite'
        : 'sharing.access.readOnly'
    );
  }

  function untilDate(seconds: number): string {
    const date = new Date(seconds * 1000);
    const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };
    try {
      return new Intl.DateTimeFormat(i18n.language, options).format(date);
    } catch {
      return new Intl.DateTimeFormat(undefined, options).format(date);
    }
  }

  async function refresh() {
    try {
      links = await listShareLinks(collectionId);
      loadFailed = false;
    } catch (err) {
      console.error('[ShareLinks] list failed', err);
      loadFailed = true;
    }
  }

  async function create() {
    pending = true;
    error = null;
    try {
      const made = await createShareLink({
        collection_id: collectionId,
        access_level: accessLevel,
        max_uses: people,
        expires_in_days: days,
        allow_signup: signupByLink && allowSignup
      });
      created = made.link;
      copied = false;
      // Making a link shares the folder if it was not shared yet.
      void loadTree();
      await refresh();
    } catch (err) {
      console.error('[ShareLinks] create failed', err);
      error = describeRefusal(err);
    } finally {
      pending = false;
    }
  }

  async function copy() {
    if (created === null) return;
    try {
      await navigator.clipboard.writeText(created);
      copied = true;
      pushToast(tUi('sharing.links.copied'), { variant: 'success' });
    } catch (err) {
      // No clipboard access. The text is selectable, so nothing is lost.
      console.warn('[ShareLinks] copy failed', err);
    }
  }

  async function remove(uid: string) {
    removing = uid;
    try {
      await revokeShareLink(uid);
      await refresh();
    } catch (err) {
      console.error('[ShareLinks] remove failed', uid, err);
      pushToast(tUi('sharing.links.removeFailed'), { variant: 'error' });
    } finally {
      removing = null;
    }
  }

  onMount(() => {
    void refresh();
  });
</script>

<section class="space-y-2" data-testid="share-links">
  <div class="flex items-center gap-1.5 text-xs font-medium">
    <Link class="size-3.5 text-primary" />
    <span>{tUi('sharing.links.heading')}</span>
  </div>
  <p class="text-xs text-muted-foreground">{tUi('sharing.links.hint')}</p>

  {#if created !== null}
    <div
      class="space-y-1.5 rounded-md border border-primary/40 bg-primary/5 p-2"
      data-testid="share-link-created"
    >
      <p class="text-xs">{tUi('sharing.links.created')}</p>
      <div
        class="select-all break-all rounded-md border border-border bg-background p-1.5 font-mono text-[11px] leading-relaxed"
        data-testid="share-link-text"
      >
        {created}
      </div>
      <Button type="button" size="sm" variant="secondary" onclick={copy}>
        <span class="inline-flex items-center">
          {#if copied}
            <Check class="mr-1.5 size-3.5" />
          {:else}
            <Copy class="mr-1.5 size-3.5" />
          {/if}
          {tUi('sharing.links.copy')}
        </span>
      </Button>
    </div>
  {/if}

  {#if loadFailed}
    <p class="text-xs text-destructive">{tUi('sharing.links.loadFailed')}</p>
  {:else if links.length > 0}
    <ul class="space-y-1">
      {#each links as link (link.uid)}
        <li class="flex items-center gap-2 text-xs" data-testid="share-link">
          <span class="min-w-0 flex-1 truncate">
            {accessLabel(link.access_level)}
            <span class="text-muted-foreground">
              · {tUiFormat('sharing.links.uses', {
                used: link.uses,
                max: link.max_uses
              })}
              · {tUiFormat('sharing.links.expires', {
                date: untilDate(link.expires_at)
              })}
            </span>
          </span>
          <button
            type="button"
            class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            disabled={removing === link.uid}
            aria-label={tUi('sharing.links.remove')}
            title={tUi('sharing.links.remove')}
            onclick={() => void remove(link.uid)}
          >
            <Trash2 class="size-3.5" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="flex flex-wrap items-center gap-1.5">
    <select
      class={FIELD_CLASS}
      aria-label={tUi('sharing.dialog.permissionLabel')}
      value={accessLevel}
      disabled={pending}
      onchange={(event) =>
        (accessLevel = event.currentTarget.value as ShareLinkAccessLevel)}
    >
      <option value="read_only">{tUi('sharing.access.readOnly')}</option>
      <option value="read_write">{tUi('sharing.access.readWrite')}</option>
    </select>
    <select
      class={FIELD_CLASS}
      aria-label={tUi('sharing.links.peopleLabel')}
      value={people}
      disabled={pending}
      onchange={(event) => (people = Number(event.currentTarget.value))}
    >
      {#each PEOPLE as count (count)}
        <option value={count}>{people_(count)}</option>
      {/each}
    </select>
    <select
      class={FIELD_CLASS}
      aria-label={tUi('sharing.links.lastsLabel')}
      value={days}
      disabled={pending}
      onchange={(event) => (days = Number(event.currentTarget.value))}
    >
      {#each DAYS as count (count)}
        <option value={count}>{days_(count)}</option>
      {/each}
    </select>
    <Button type="button" size="sm" disabled={pending} onclick={create}>
      {tUi('sharing.links.create')}
    </Button>
  </div>
  {#if signupByLink}
    <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
      <input type="checkbox" bind:checked={allowSignup} disabled={pending} />
      <span>{tUi('sharing.links.allowSignup')}</span>
    </label>
  {/if}
  {#if error}
    <p class="text-xs text-destructive">{error}</p>
  {/if}
</section>
