<script lang="ts">
  import { tick, onMount } from 'svelte';
  import SettingSelect from '$lib/settings/SettingSelect.svelte';
  import WindowControls from '$lib/components/WindowControls.svelte';
  import {
    initWindowChrome,
    windowChrome
  } from '$lib/window/decorations.svelte';
  import {
    ArrowLeft,
    ArrowRight,
    Check,
    HardDrive,
    Server,
    Cloud,
    Monitor,
    Sun,
    Moon,
    FileText,
    Upload,
    ArchiveRestore,
    Languages
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    getSettingValue,
    setSettingValue,
    SCHEMA,
    flushSettingsWrites
  } from '$lib/settings/store.svelte';
  import SettingControl from '$lib/settings/SettingControl.svelte';
  import SignInForm from '$lib/settings/customs/SignInForm.svelte';
  import HotkeyPreset from '$lib/settings/customs/HotkeyPreset.svelte';
  import SpellcheckDictionaries from '$lib/settings/customs/SpellcheckDictionaries.svelte';
  import { tUi, tUiFormat, tValue } from '$lib/settings/i18n.svelte';
  import { themeCatalog } from '$lib/settings/theme.svelte';
  import { BUILTIN_PRESET_NAMES } from '$lib/settings/theme-presets';
  import { authSession } from '$lib/api/auth.svelte';
  import {
    ONBOARDING_STEPS,
    finishOnboarding,
    saveOnboardingStep,
    type OnboardingStep,
    type InitialNote
  } from '$lib/api/onboarding';
  import { toErrorMessage } from '$lib/api/errors';
  import { isMobile } from '$lib/platform';
  import { coerceViewMode } from '$lib/editor/source/view-mode';
  import { splitAvailable } from '$lib/editor/source/split-available.svelte';
  import { getBinding } from '$lib/hotkeys/store.svelte';
  import { displayBinding } from '$lib/hotkeys/format';
  import { loadTree } from '$lib/stores/tree.svelte';
  import { onboarding } from './store.svelte';
  import AppearancePreview from './AppearancePreview.svelte';
  import PracticeEditor from './PracticeEditor.svelte';

  let { oncomplete }: { oncomplete: () => void } = $props();
  let busy = $state(false);
  let error = $state('');
  let previewUiFontSize = $state<number | null>(null);
  let heading: HTMLHeadingElement;
  let container: HTMLElement;
  onMount(() => {
    if (!isMobile()) initWindowChrome();
  });
  let content = $state<'welcome' | 'blank' | 'none' | null>(null);
  const step = $derived(onboarding.progress?.step ?? 'account');
  const stepIndex = $derived(ONBOARDING_STEPS.indexOf(step));
  const signedIn = $derived(!!authSession.current);
  const local = $derived(
    getSettingValue('account.serverType') === 'local-only'
  );
  const chosenContent = $derived(
    content ??
      (onboarding.progress?.freshInstall && !signedIn ? 'welcome' : 'none')
  );
  const settings = SCHEMA.categories.flatMap((category) =>
    category.sections.flatMap((section) => section.settings)
  );
  const setting = (id: string) =>
    settings.find((setting) => setting.id === id)!;
  const titles = {
    account: 'onboarding.account.title',
    appearance: 'onboarding.appearance.title',
    editing: 'onboarding.editing.title',
    start: 'onboarding.start.title'
  } as const;
  const descriptions = {
    account: 'onboarding.account.description',
    appearance: 'onboarding.appearance.description',
    editing: 'onboarding.editing.description',
    start: 'onboarding.start.description'
  } as const;

  async function perform(action: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await action();
    } catch (cause) {
      error = toErrorMessage(cause);
    } finally {
      busy = false;
    }
  }
  function write(id: string, value: unknown) {
    void perform(() => setSettingValue(id, value));
  }
  function selectPreset(id: string) {
    write('appearance.preset', id);
  }
  async function navigate(target: OnboardingStep) {
    await perform(async () => {
      previewUiFontSize = null;
      await flushSettingsWrites();
      onboarding.progress = await saveOnboardingStep(
        onboarding.progress!.id,
        target
      );
      await tick();
      container?.scrollTo({ top: 0 });
      heading?.focus({ preventScroll: true });
    });
  }
  function initialNote(kind: 'welcome' | 'blank' | 'none'): InitialNote | null {
    if (kind === 'none') return null;
    return {
      title: tUi(
        kind === 'welcome'
          ? 'onboarding.welcome.title'
          : 'onboarding.blank.title'
      ),
      body:
        kind === 'welcome'
          ? tUiFormat('onboarding.welcome.body', {
              create: displayBinding(getBinding('global.newMarkdownNote')),
              search: displayBinding(getBinding('global.openSearch')),
              commands: displayBinding(getBinding('global.openCommandPalette'))
            })
          : ''
    };
  }
  async function complete(
    skipped = false,
    action?: 'import-notes' | 'restore-backup'
  ) {
    await perform(async () => {
      if (skipped && onboarding.progress?.freshInstall && !signedIn)
        await setSettingValue('account.serverType', 'local-only');
      await flushSettingsWrites();
      const note = action
        ? null
        : initialNote(
            skipped
              ? onboarding.progress?.freshInstall && !signedIn
                ? 'welcome'
                : 'none'
              : chosenContent
          );
      onboarding.finishing = true;
      try {
        const finished = await finishOnboarding(
          onboarding.progress!.id,
          skipped,
          note
        );
        // Set the opening intent before removing the setup view.
        onboarding.initialNoteId = finished.noteId;
        await loadTree();
        onboarding.progress = finished.progress;
      } finally {
        onboarding.finishing = false;
      }
      oncomplete();
      if (action) {
        await tick();
        const { DATA_ACTIONS } = await import('$lib/settings/actions/data');
        await DATA_ACTIONS[action]();
      }
    });
  }
</script>

<main class="onboarding" aria-labelledby="onboarding-heading">
  <header class="setup-header" data-tauri-drag-region>
    <span class="flex items-center gap-2 font-medium" data-tauri-drag-region
      ><img
        src="/app-logo.png"
        alt=""
        class="size-6 shrink-0"
        width="24"
        height="24"
        draggable="false"
      /><span class="text-base font-semibold tracking-tight"
        >mindstream<span class="text-accent-brand">.</span></span
      ></span
    >
    <div class="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
      <span class="hidden sm:inline">{tUi('onboarding.language')}</span>
      <SettingSelect
        settingId="language.code"
        value={String(getSettingValue('language.code'))}
        options={['en', 'de']}
        ariaLabel={tUi('onboarding.language')}
        icon={Languages}
        class="h-11 w-auto text-xs"
        disabled={busy}
        touchFriendly
        onChange={(value) => write('language.code', value)}
      />
    </div>
    {#if !isMobile() && windowChrome.customDecorations}<WindowControls />{/if}
  </header>
  <div bind:this={container} class="setup-content">
    <div class="setup-body">
      <nav aria-label={tUi('onboarding.progress')} class="setup-progress">
        <ol class="steps">
          {#each ONBOARDING_STEPS as item, index (item)}
            <li
              aria-current={step === item ? 'step' : undefined}
              class:current={step === item}
              class:completed={index < stepIndex}
            >
              <span class="step-dot"
                >{#if index < stepIndex}<Check
                    class="size-3.5"
                  />{:else}{index + 1}{/if}</span
              >
              <span class="step-label">{tUi(`onboarding.step.${item}`)}</span>
            </li>
          {/each}
        </ol>
      </nav>
      <h1
        id="onboarding-heading"
        bind:this={heading}
        tabindex="-1"
        class="setup-title mb-3 text-3xl font-semibold tracking-tight focus:outline-none"
      >
        {tUi(titles[step])}
      </h1>
      <p
        class="setup-description max-w-2xl text-sm leading-relaxed text-muted-foreground"
      >
        {tUi(descriptions[step])}
      </p>

      {#if step === 'account'}
        <div
          class="account-options"
          role="group"
          aria-label={tUi('onboarding.account.title')}
        >
          {#each ['local-only', 'self-hosted', 'managed'] as target (target)}
            {@const Icon =
              target === 'local-only'
                ? HardDrive
                : target === 'self-hosted'
                  ? Server
                  : Cloud}
            <button
              type="button"
              class="choice"
              class:selected={getSettingValue('account.serverType') === target}
              aria-pressed={getSettingValue('account.serverType') === target}
              disabled={busy || signedIn || target === 'managed'}
              onclick={() => write('account.serverType', target)}
            >
              <Icon
                class="choice-icon size-5 text-accent-brand"
                aria-hidden="true"
              />
              <span class="choice-copy"
                ><span class="block font-medium"
                  >{tUi(`onboarding.account.${target}.title`)}</span
                >
                <span
                  class="choice-description block text-sm text-muted-foreground"
                  >{tUi(`onboarding.account.${target}.description`)}</span
                ></span
              >
              <span class="choice-indicator" aria-hidden="true">
                {#if getSettingValue('account.serverType') === target}<Check
                    class="size-3"
                  />{/if}
              </span>
            </button>
          {/each}
        </div>
        {#if !local || signedIn}
          <div class="mt-5"><SignInForm /></div>
        {/if}
        <p class="mt-5 text-sm text-muted-foreground">
          {tUi(
            local
              ? 'onboarding.account.localHint'
              : 'onboarding.account.remoteHint'
          )}
        </p>
      {:else if step === 'appearance'}
        <div class="appearance-grid">
          <div class="min-w-0 space-y-6">
            <fieldset disabled={busy}>
              <legend class="mb-3 text-sm font-medium"
                >{tUi('onboarding.appearance.mode')}</legend
              >
              <div class="flex flex-wrap gap-2">
                {#each ['system', 'light', 'dark'] as mode (mode)}
                  {@const Icon =
                    mode === 'system' ? Monitor : mode === 'light' ? Sun : Moon}
                  <Button
                    variant={getSettingValue('appearance.mode') === mode
                      ? 'secondary'
                      : 'outline'}
                    aria-pressed={getSettingValue('appearance.mode') === mode}
                    onclick={() => write('appearance.mode', mode)}
                    ><Icon class="mr-2 size-4" />{tValue(
                      'appearance.mode',
                      mode
                    )}</Button
                  >
                {/each}
              </div>
            </fieldset>
            <fieldset disabled={busy}>
              <legend class="mb-3 text-sm font-medium"
                >{tUi('onboarding.appearance.theme')}</legend
              >
              <div class="flex flex-wrap gap-2">
                {#each themeCatalog.presets as preset (preset.id)}
                  <Button
                    variant={getSettingValue('appearance.preset') === preset.id
                      ? 'secondary'
                      : 'outline'}
                    aria-pressed={getSettingValue('appearance.preset') ===
                      preset.id}
                    onclick={() => selectPreset(preset.id)}
                    >{Object.hasOwn(BUILTIN_PRESET_NAMES, preset.id)
                      ? tUi(
                          BUILTIN_PRESET_NAMES[
                            preset.id as keyof typeof BUILTIN_PRESET_NAMES
                          ]
                        )
                      : preset.name}</Button
                  >
                {/each}
              </div>
            </fieldset>
            {#if themeCatalog.error}<p
                role="status"
                class="text-sm text-muted-foreground"
              >
                {themeCatalog.error}
              </p>{/if}
            <SettingControl
              setting={setting('appearance.uiFontSize')}
              bind:sliderPreview={previewUiFontSize}
            />
            <SettingControl
              live
              setting={setting('appearance.editorFontSize')}
            />
            <details>
              <summary class="text-sm"
                >{tUi('onboarding.appearance.comfort')}</summary
              >
              <div class="mt-4 space-y-4">
                <SettingControl
                  live
                  setting={setting('appearance.lineHeight')}
                /><SettingControl
                  setting={setting('appearance.reduceMotion')}
                />
              </div>
            </details>
          </div>
          <div class="min-w-0">
            <AppearancePreview uiFontSize={previewUiFontSize} />
            <p class="mt-3 text-xs text-muted-foreground">
              {tUi('onboarding.appearance.previewHint')}
            </p>
          </div>
        </div>
      {:else if step === 'editing'}
        <div class="editing-grid">
          <div class="space-y-6">
            <fieldset disabled={busy}>
              <legend class="mb-3 text-sm font-medium"
                >{tUi('onboarding.editing.mode')}</legend
              >
              <div class="flex flex-col gap-2">
                {#each ['wysiwyg', 'source', 'split'] as mode (mode)}
                  {#if mode !== 'split' || splitAvailable()}
                    <Button
                      class="justify-start"
                      variant={getSettingValue('editor.defaultMode') === mode
                        ? 'secondary'
                        : 'outline'}
                      aria-pressed={getSettingValue('editor.defaultMode') ===
                        mode}
                      onclick={() => write('editor.defaultMode', mode)}
                      >{tValue('editor.defaultMode', mode)}</Button
                    >
                  {/if}
                {/each}
              </div>
            </fieldset>
            {#if !isMobile()}
              <div>
                <p class="mb-3 text-sm font-medium">
                  {tUi('onboarding.shortcuts')}
                </p>
                <HotkeyPreset />
                <p class="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {tUi('onboarding.shortcutsHint')}
                </p>
              </div>
              <dl class="space-y-2 text-sm">
                {#each ['h1', 'bulletList', 'orderedList', 'codeBlock'] as command (command)}
                  <div class="flex flex-wrap justify-between gap-2">
                    <dt class="text-muted-foreground">
                      {tUi(`hotkeys.command.editor.markdown.${command}`)}
                    </dt>
                    <dd class="font-mono text-xs">
                      {displayBinding(
                        getBinding(`editor.markdown.${command}`)
                      ) || tUi('onboarding.unassigned')}
                    </dd>
                  </div>
                {/each}
              </dl>
            {/if}
            <details>
              <summary class="text-sm">{tUi('onboarding.spelling')}</summary>
              <div class="mt-4 space-y-4">
                <SettingControl
                  setting={setting('language.spellcheck.enabled')}
                /><SpellcheckDictionaries />
              </div>
            </details>
          </div>
          <div class="min-w-0">
            <h2 class="mb-3 text-sm font-medium">
              {tUi('onboarding.practice.title')}
            </h2>
            <PracticeEditor
              mode={coerceViewMode(
                getSettingValue('editor.defaultMode'),
                splitAvailable()
              )}
            />
            <p class="mt-3 text-xs leading-relaxed text-muted-foreground">
              {tUi('onboarding.practice.hint')}
            </p>
          </div>
        </div>
      {:else}
        <div
          class="account-options"
          role="group"
          aria-label={tUi('onboarding.start.title')}
        >
          {#each ['welcome', 'blank', 'none'] as kind (kind)}
            <button
              type="button"
              class="choice"
              class:selected={chosenContent === kind}
              aria-pressed={chosenContent === kind}
              disabled={busy}
              onclick={() => (content = kind as typeof content)}
            >
              <FileText
                class="choice-icon size-5 text-accent-brand"
                aria-hidden="true"
              /><span class="choice-copy"
                ><span class="block font-medium"
                  >{tUi(`onboarding.start.${kind}.title`)}</span
                ><span
                  class="choice-description block text-sm text-muted-foreground"
                  >{tUi(`onboarding.start.${kind}.description`)}</span
                ></span
              >
              <span class="choice-indicator" aria-hidden="true">
                {#if chosenContent === kind}<Check class="size-3" />{/if}
              </span>
            </button>
          {/each}
        </div>
        <div class="mt-6 flex flex-wrap gap-3">
          <Button
            variant="outline"
            disabled={busy}
            onclick={() => complete(false, 'import-notes')}
            ><Upload class="mr-2 size-4" />{tUi('onboarding.import')}</Button
          >
          <Button
            variant="outline"
            disabled={busy}
            onclick={() => complete(false, 'restore-backup')}
            ><ArchiveRestore class="mr-2 size-4" />{tUi(
              'onboarding.restore'
            )}</Button
          >
        </div>
        <p class="mt-5 text-sm text-muted-foreground">
          {tUi('onboarding.start.hint')}
        </p>
      {/if}

      {#if error}<p
          role="alert"
          class="mt-6 rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {error}
        </p>{/if}
    </div>
  </div>
  <footer class="setup-footer">
    <div class="setup-footer-inner">
      {#if stepIndex > 0}<Button
          variant="ghost"
          class="setup-back"
          disabled={busy}
          onclick={() => navigate(ONBOARDING_STEPS[stepIndex - 1])}
          ><ArrowLeft class="mr-2 size-4" />{tUi('onboarding.back')}</Button
        >{/if}
      <span class="setup-saved mr-auto text-xs text-muted-foreground"
        >{tUi('onboarding.saved')}</span
      >
      <div class="setup-actions">
        <Button
          variant="secondary"
          class={`setup-skip h-auto min-h-11 whitespace-normal text-center ${step !== 'account' ? 'setup-skip-placeholder' : ''}`}
          disabled={busy || step !== 'account'}
          aria-hidden={step !== 'account' ? true : undefined}
          tabindex={step === 'account' ? undefined : -1}
          onclick={() => complete(true)}
          >{tUi(
            onboarding.progress?.freshInstall
              ? 'onboarding.skip'
              : 'onboarding.keepCurrent'
          )}</Button
        >
        <Button
          class="setup-next min-h-11"
          disabled={busy || (step === 'account' && !local && !signedIn)}
          onclick={() =>
            step === 'start'
              ? complete()
              : navigate(ONBOARDING_STEPS[stepIndex + 1])}
        >
          {tUi(
            busy
              ? 'onboarding.working'
              : step === 'start'
                ? 'onboarding.finish'
                : 'onboarding.continue'
          )}<ArrowRight class="ml-2 size-4" />
        </Button>
      </div>
    </div>
  </footer>
</main>

<style>
  .onboarding {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
    background: var(--color-surface-0);
    color: var(--color-foreground);
  }
  .setup-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 1rem;
    padding: calc(1rem + env(safe-area-inset-top)) 2rem 1rem;
    border-bottom: 1px solid var(--color-border);
  }
  .setup-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    scroll-padding-block: 1rem;
  }
  .setup-body {
    width: 100%;
    max-width: 76rem;
    margin: 0 auto;
    padding: 2rem;
  }
  .setup-progress {
    margin-bottom: 1.75rem;
  }
  .setup-description {
    margin-bottom: 1.5rem;
  }
  .steps {
    display: flex;
    gap: 0.75rem;
    max-width: 44rem;
  }
  .steps li {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: var(--color-muted-foreground);
  }
  .steps li:last-child {
    flex: 0 0 auto;
  }
  .steps li:not(:last-child)::after {
    content: '';
    flex: 1;
    min-width: 0.75rem;
    height: 1px;
    background: var(--color-border-strong);
  }
  .steps li.completed::after {
    background: var(--color-accent-brand);
  }
  .step-label {
    white-space: nowrap;
  }
  .steps li.current {
    color: var(--color-foreground);
  }
  .step-dot {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    background: var(--color-surface-2);
  }
  .current .step-dot {
    background: var(--color-accent-brand);
    color: var(--color-accent-brand-foreground);
  }
  .account-options {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
  }
  .choice {
    display: grid;
    grid-template-columns: 1.25rem minmax(0, 1fr) 1rem;
    align-items: start;
    gap: 0.75rem;
    padding: 1rem;
    text-align: left;
    border: 1px solid var(--color-border);
    border-radius: 0.75rem;
    background: var(--color-surface-1);
  }
  .choice :global(.choice-icon) {
    margin-top: 0.125rem;
  }
  .choice-copy {
    min-width: 0;
  }
  .choice-description {
    margin-top: 0.25rem;
    line-height: 1.5;
  }
  .choice-indicator {
    display: grid;
    place-items: center;
    width: 1rem;
    height: 1rem;
    margin-top: 0.25rem;
    border: 1px solid var(--color-border-strong);
    border-radius: 50%;
  }
  .selected .choice-indicator {
    border-color: var(--color-accent-brand);
    background: var(--color-accent-brand);
    color: var(--color-accent-brand-foreground);
  }
  .choice:focus-visible {
    outline: 2px solid var(--color-accent-brand);
    outline-offset: 3px;
  }
  .choice:hover:not(:disabled) {
    background: var(--color-surface-2);
  }
  .choice.selected {
    border-color: var(--color-accent-brand);
    box-shadow: 0 0 0 1px var(--color-accent-brand);
  }
  .choice:disabled {
    opacity: 0.55;
  }
  .choice.selected:disabled {
    opacity: 1;
  }
  .appearance-grid {
    display: grid;
    grid-template-columns: minmax(16rem, 0.8fr) minmax(0, 1.6fr);
    gap: 2.5rem;
    align-items: start;
  }
  .editing-grid {
    display: grid;
    grid-template-columns: minmax(14rem, 0.7fr) minmax(0, 1.3fr);
    gap: 2.5rem;
  }
  .setup-footer {
    flex-shrink: 0;
    padding: 0.75rem 2rem calc(0.75rem + env(safe-area-inset-bottom));
    border-top: 1px solid var(--color-border);
    background: var(--color-surface-0);
  }
  .setup-footer-inner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
    max-width: 72rem;
    margin: 0 auto;
  }
  .setup-actions {
    display: flex;
    align-items: stretch;
    justify-content: flex-end;
    gap: 0.75rem;
    max-width: 100%;
    margin-left: auto;
  }
  .setup-footer :global(.setup-next) {
    flex-shrink: 0;
  }
  .setup-footer :global(.setup-back) {
    min-height: 2.75rem;
  }
  .setup-footer :global(.setup-skip-placeholder) {
    display: none;
  }
  @media (max-width: 900px) {
    .appearance-grid,
    .editing-grid {
      grid-template-columns: 1fr;
      gap: 2rem;
    }
  }
  @media (max-width: 600px) {
    :global(.onboarding input[type='range']) {
      width: 7rem;
    }
    .setup-header {
      gap: 0.5rem;
      padding: calc(0.75rem + env(safe-area-inset-top)) 1rem 0.75rem;
    }
    .setup-body {
      padding: 1.25rem 1rem 4.5rem;
    }
    .setup-content {
      scroll-padding-bottom: 4.5rem;
    }
    .setup-progress {
      margin-bottom: 1.25rem;
    }
    .setup-title {
      font-size: 1.5rem;
      line-height: 1.25;
    }
    .setup-description {
      margin-bottom: 1.25rem;
    }
    .account-options {
      grid-template-columns: 1fr;
    }
    .choice {
      padding: 0.875rem;
    }
    .steps {
      gap: 0.5rem;
    }
    .steps li {
      gap: 0.375rem;
    }
    .steps li:not(:last-child)::after {
      min-width: 0.5rem;
    }
    .steps li:not(.current) .step-label {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .setup-footer {
      position: relative;
      padding: 0.5rem 0.5rem max(0.5rem, env(safe-area-inset-bottom));
      border-top: 1px solid var(--color-border);
      background: transparent;
    }
    .setup-saved {
      display: none;
    }
    .setup-footer-inner {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-template-rows: minmax(2.75rem, auto);
      gap: 0.5rem;
    }
    .setup-actions {
      display: contents;
    }
    .setup-footer :global(.setup-skip) {
      position: absolute;
      right: 0.5rem;
      bottom: calc(100% + 0.5rem);
      justify-content: flex-start;
      width: fit-content;
      max-width: calc(100% - 1rem);
      min-width: 0;
      padding-inline: 0.75rem;
      border: 1px solid
        color-mix(in oklab, var(--color-border) 35%, transparent);
      border-radius: 999px;
      background: color-mix(in oklab, var(--color-surface-1) 20%, transparent);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      box-shadow: none;
      opacity: 0.7;
      transition:
        opacity 150ms,
        background-color 150ms;
      color: var(--color-foreground);
      font-size: 0.75rem;
      font-weight: 400;
      line-height: 1.4;
      text-align: left;
    }
    .setup-footer :global(.setup-skip:hover:not(:disabled)),
    .setup-footer :global(.setup-skip:focus-visible) {
      background: color-mix(in oklab, var(--color-surface-2) 35%, transparent);
      opacity: 1;
    }
    .setup-footer :global(.setup-skip-placeholder) {
      display: inline-flex;
      visibility: hidden;
      pointer-events: none;
    }
    .setup-footer :global(.setup-back) {
      grid-area: 1 / 1;
      justify-self: start;
      /* Line the arrow up with the content's 1rem gutter. */
      padding-inline-start: 0.5rem;
    }
    .setup-footer :global(.setup-next) {
      grid-area: 1 / 2;
      min-width: 0;
      height: auto;
      white-space: normal;
    }
  }
</style>
