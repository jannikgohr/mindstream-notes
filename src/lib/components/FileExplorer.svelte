<script lang="ts">
  import { ChevronRight, FileText, Folder, FolderOpen, Plus } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { MOCK_TREE, type TreeNode } from '$lib/mocks';

  interface Props {
    onOpenNote: (id: string) => void;
  }
  let { onOpenNote }: Props = $props();

  let tree = $state<TreeNode[]>(MOCK_TREE);
  let expanded = $state<Record<string, boolean>>({ Work: true, Personal: true });

  function toggleFolder(name: string) {
    expanded[name] = !expanded[name];
  }
</script>

<aside class="flex h-full w-full flex-col bg-card text-sm">
  <div class="flex items-center justify-between px-3 py-2">
    <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      Explorer
    </span>
    <Button variant="ghost" size="icon" title="New note" aria-label="New note">
      <Plus class="size-3.5" />
    </Button>
  </div>

  <div class="flex-1 overflow-y-auto px-1 pb-2">
    {#each tree as node (node.kind === 'folder' ? `f:${node.name}` : `n:${node.id}`)}
      {#if node.kind === 'folder'}
        <button
          type="button"
          class="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
          onclick={() => toggleFolder(node.name)}
        >
          <ChevronRight
            class={`size-3.5 shrink-0 transition-transform ${expanded[node.name] ? 'rotate-90' : ''}`}
          />
          {#if expanded[node.name]}
            <FolderOpen class="size-3.5 shrink-0 text-muted-foreground" />
          {:else}
            <Folder class="size-3.5 shrink-0 text-muted-foreground" />
          {/if}
          <span class="truncate">{node.name}</span>
        </button>
        {#if expanded[node.name]}
          <div class="ml-3 border-l border-border pl-1">
            {#each node.children as child (child.kind === 'folder' ? `f:${child.name}` : `n:${child.id}`)}
              {#if child.kind === 'note'}
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                  onclick={() => onOpenNote(child.id)}
                >
                  <FileText class="size-3.5 shrink-0 text-muted-foreground" />
                  <span class="truncate">{child.name}</span>
                </button>
              {/if}
            {/each}
          </div>
        {/if}
      {:else}
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
          onclick={() => onOpenNote(node.id)}
        >
          <FileText class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate">{node.name}</span>
        </button>
      {/if}
    {/each}
  </div>
</aside>
