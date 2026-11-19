<script lang="ts">
  /** The `calendar` node of a schema view: a month grid with marked days. */
  import { untrack } from 'svelte';
  import { Calendar } from 'bits-ui';
  import { parseDate, type DateValue } from '@internationalized/date';
  import { ChevronLeft, ChevronRight } from '@lucide/svelte';
  import { i18n, tUi } from '$lib/settings/i18n.svelte';
  import type { ViewNode } from './view-schema';

  type CalendarNode = Extract<ViewNode, { type: 'calendar' }>;
  let {
    node,
    onEvent
  }: { node: CalendarNode; onEvent: (event: string, value: string) => void } =
    $props();

  const MONTH_BUTTON =
    'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

  // The week starts where the user's region starts it, not the UI language's.
  function firstWeekday(): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
    try {
      const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
        getWeekInfo?: () => { firstDay: number };
        weekInfo?: { firstDay: number };
      };
      const firstDay = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
      return ((firstDay ?? 1) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
    } catch {
      return 1;
    }
  }
  const weekStartsOn = firstWeekday();

  // Parsed from the strings, so a redraw with the same day and month hands
  // bits-ui the same objects: a new `value` object counts as a new selection,
  // and bits-ui then jumps back to the selected day's month.
  const selectedKey = $derived(node.selected);
  const monthKey = $derived(node.month);
  const value = $derived(selectedKey ? parseDate(selectedKey) : undefined);
  // The shown month belongs to the plugin. bits-ui moves it to the selected
  // day at mount and on each selection by assigning that very `value`; month
  // buttons and keyboard paging assign new dates.
  let placeholder = $state(parseDate(`${untrack(() => monthKey)}-01`));
  $effect.pre(() => {
    placeholder = parseDate(`${monthKey}-01`);
  });
  const monthOf = (date: DateValue) => date.toString().slice(0, 7);
</script>

<Calendar.Root
  type="single"
  {value}
  bind:placeholder
  onPlaceholderChange={(next) => {
    if (next === value) placeholder = parseDate(`${monthKey}-01`);
    else if (monthOf(next) !== node.month) onEvent(node.onMonth, monthOf(next));
  }}
  onValueChange={(next) => {
    if (next) onEvent(node.onSelect, next.toString());
  }}
  preventDeselect
  fixedWeeks
  {weekStartsOn}
  weekdayFormat="narrow"
  locale={i18n.language}
  class="w-full"
>
  {#snippet children({ months, weekdays })}
    <Calendar.Header class="flex h-11 items-center justify-between gap-2 pl-1">
      <Calendar.Heading class="min-w-0 truncate text-[13px] font-medium" />
      <div class="flex shrink-0 items-center">
        <Calendar.PrevButton
          class={MONTH_BUTTON}
          aria-label={tUi('calendar.previousMonth')}
        >
          <ChevronLeft class="size-4" />
        </Calendar.PrevButton>
        <Calendar.NextButton
          class={MONTH_BUTTON}
          aria-label={tUi('calendar.nextMonth')}
        >
          <ChevronRight class="size-4" />
        </Calendar.NextButton>
      </div>
    </Calendar.Header>
    {#each months as month (month.value.toString())}
      <Calendar.Grid class="w-full border-collapse">
        <Calendar.GridHead>
          <Calendar.GridRow class="grid grid-cols-7">
            {#each weekdays as day, i (i)}
              <Calendar.HeadCell
                class="pb-1 text-[10px] font-medium uppercase text-muted-foreground"
                >{day}</Calendar.HeadCell
              >
            {/each}
          </Calendar.GridRow>
        </Calendar.GridHead>
        <Calendar.GridBody class="grid gap-y-0.5">
          {#each month.weeks as week, w (w)}
            <Calendar.GridRow class="grid grid-cols-7">
              {#each week as date (date.toString())}
                {@const mark = node.days[date.toString()]}
                <Calendar.Cell {date} month={month.value} class="p-0">
                  <Calendar.Day
                    title={mark?.title}
                    class="group mx-auto flex size-8 flex-col items-center justify-center rounded-md text-xs tabular-nums transition-colors hover:bg-accent data-[outside-month]:text-muted-foreground/50 data-[today]:text-accent-brand data-[today]:ring-1 data-[today]:ring-inset data-[today]:ring-accent-brand/50 data-[selected]:bg-accent-brand data-[selected]:text-accent-brand-foreground data-[selected]:ring-0 data-[selected]:hover:bg-accent-brand {mark?.strong
                      ? 'font-semibold'
                      : ''}"
                  >
                    <span class="leading-none">{date.day}</span>
                    <span
                      class="mt-0.5 flex h-1 items-center gap-px"
                      aria-hidden="true"
                    >
                      {#each mark?.marks ?? [] as kind, i (i)}
                        <span
                          class="size-1 rounded-full {kind === 'accent'
                            ? 'bg-accent-brand group-data-[selected]:bg-accent-brand-foreground'
                            : 'bg-muted-foreground/50 group-data-[selected]:bg-accent-brand-foreground/60'}"
                        ></span>
                      {/each}
                    </span>
                  </Calendar.Day>
                </Calendar.Cell>
              {/each}
            </Calendar.GridRow>
          {/each}
        </Calendar.GridBody>
      </Calendar.Grid>
    {/each}
  {/snippet}
</Calendar.Root>
