<script lang="ts">
  import { onMount } from 'svelte';
  import { BrowserStorageClient } from '$lib/browser/client';
  import { storageError, type ProofReport } from '$lib/browser/protocol';

  let client: BrowserStorageClient;
  let status = $state('Opening database');
  let errorCode = $state('');
  let marker = $state('');
  let persisted = $state<string | null>(null);
  let report = $state<ProofReport | null>(null);

  async function open() {
    client?.dispose();
    client = new BrowserStorageClient();
    errorCode = '';
    report = null;
    status = 'Opening database';
    try {
      await client.request('open', undefined);
      report = await client.request('verify', undefined);
      persisted = await client.request('read', undefined);
      marker = persisted ?? '';
      status = 'Ready';
    } catch (error) {
      const failure = storageError(error);
      errorCode = failure.code;
      status = failure.message;
    }
  }

  async function save() {
    try {
      await client.request('write', { body: marker });
      persisted = await client.request('read', undefined);
      status = 'Saved';
    } catch (error) {
      status = storageError(error).message;
    }
  }

  async function close() {
    try {
      await client.close();
      status = 'Closed';
      report = null;
    } catch (error) {
      status = storageError(error).message;
    }
  }

  onMount(() => {
    void open();
    return () => client?.dispose();
  });
</script>

<svelte:head><title>Browser SQLite proof</title></svelte:head>
<main class="mx-auto max-w-2xl space-y-6 p-8">
  <h1 class="text-2xl font-semibold">Browser SQLite proof</h1>
  <p>
    This separate test database runs the app's migrations in a Rust Wasm worker.
    It uses OPFS storage on this origin.
  </p>
  <p role="status" data-error-code={errorCode}>{status}</p>
  {#if report}
    <pre data-testid="proof-report">{JSON.stringify(report, null, 2)}</pre>
    <label class="block"
      >Persistence marker
      <textarea class="block w-full border p-2" bind:value={marker}></textarea>
    </label>
    <p>
      Stored marker: <span data-testid="persisted-marker"
        >{persisted ?? '(empty)'}</span
      >
    </p>
    <button class="rounded border px-4 py-2" onclick={save}>Save marker</button>
    <button class="rounded border px-4 py-2" onclick={close}
      >Close database</button
    >
  {/if}
  <button class="rounded border px-4 py-2" onclick={open}>Retry opening</button>
</main>
