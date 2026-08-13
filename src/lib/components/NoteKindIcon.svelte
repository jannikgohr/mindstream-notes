<script lang="ts">
  /**
   * The per-note glyph for a `note_kind`, used everywhere a note is listed
   * (file tree, search, note lists, wikilink picker, kanban links, …).
   *
   * A plugin-owned note kind may ship its own `.svg` (manifest
   * `noteKinds[].icon`), rendered as a themed monochrome mask via
   * {@link PluginIcon}. Everything else falls back to the central built-in
   * Lucide mapping in {@link noteKindIcon} (which lands on the unknown-kind
   * glyph for kinds this app version doesn't know). Keeping both behind one
   * component means callers render `<NoteKindIcon kind=… class=… />` without
   * caring whether the kind is built-in or plugin-owned.
   */
  import { noteKindIcon } from './note-kind-icon';
  import { pluginNoteKind } from '$lib/plugins/registry.svelte';
  import PluginIcon from '$lib/plugins/PluginIcon.svelte';

  interface Props {
    kind: string | null | undefined;
    class?: string;
  }
  let { kind, class: klass = '' }: Props = $props();

  const pluginRef = $derived(kind ? pluginNoteKind(kind) : undefined);
  const pluginIcon = $derived(pluginRef?.contribution.icon ?? null);
</script>

{#if pluginRef && pluginIcon}
  <PluginIcon pluginId={pluginRef.pluginId} file={pluginIcon} class={klass} />
{:else}
  {@const Icon = noteKindIcon(kind)}
  <Icon class={klass} aria-hidden="true" />
{/if}
