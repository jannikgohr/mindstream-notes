<script lang="ts">
  /**
   * Example custom control: a tiny sign-in form. Wired as
   * type='custom', customId='sign-in-form' in schema.json. Replace the
   * stub with whatever real auth flow you adopt.
   */
  import { Button } from '$lib/components/ui/button';

  let email = $state('');
  let password = $state('');
  let busy = $state(false);
  let status = $state<string | null>(null);

  async function signIn() {
    busy = true;
    status = null;
    try {
      // TODO: real auth call.
      await new Promise((r) => setTimeout(r, 600));
      status = `Signed in as ${email} (stub)`;
    } finally {
      busy = false;
    }
  }
</script>

<div class="rounded-md border border-border bg-muted/40 p-3 text-sm">
  <div class="grid gap-2">
    <label class="grid gap-1">
      <span class="text-xs text-muted-foreground">Email</span>
      <input
        type="email"
        bind:value={email}
        placeholder="you@example.com"
        class="h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
    <label class="grid gap-1">
      <span class="text-xs text-muted-foreground">Password</span>
      <input
        type="password"
        bind:value={password}
        class="h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
    <div class="flex items-center justify-between gap-3 pt-1">
      <Button size="sm" onclick={signIn} disabled={busy || !email || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      {#if status}
        <span class="text-xs text-muted-foreground">{status}</span>
      {/if}
    </div>
  </div>
</div>
