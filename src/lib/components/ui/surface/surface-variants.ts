import { tv, type VariantProps } from 'tailwind-variants';
import type { WithElementRef } from 'bits-ui';
import type { HTMLAttributes } from 'svelte/elements';

/**
 * Variants live in a plain .ts file rather than the component's
 * `<script module>` for the same reason Button's do — see the note in
 * button-variants.ts.
 *
 * Surface is the app's elevation primitive. Rather than each area hand-rolling
 * its own container chrome (which is how the two sidebars, the Kanban board and
 * the dockview panels ended up looking like three different apps), pick the
 * variant that matches what the thing IS and let the token scale decide how it
 * looks in each theme. See docs/theming.md for the elevation rules.
 *
 * The variants map one-to-one onto the surface scale:
 *
 *   panel    surface-1  a pane of the app shell — sidebars, editor panel
 *   section  surface-2  a grouped region inside a panel
 *   raised   surface-3  a discrete item sitting on a section — stat tiles, cards
 *   overlay  surface-3  something genuinely floating — dialogs, popovers
 *
 * `section` deliberately carries no border and no shadow. The elevation step
 * alone delineates it, which is what keeps a stack of sections reading as one
 * grouped list rather than a pile of floating cards. Shadow is reserved for
 * `overlay`, where the thing really is above the page.
 */
export const surfaceVariants = tv({
  base: 'text-foreground',
  variants: {
    variant: {
      panel: 'bg-surface-1',
      section: 'rounded-lg bg-surface-2',
      raised: 'rounded-md bg-surface-3',
      overlay:
        'rounded-lg border border-border-strong bg-surface-3 shadow-overlay'
    },
    padding: {
      none: '',
      sm: 'p-2.5',
      md: 'p-3',
      lg: 'p-4'
    }
  },
  defaultVariants: {
    variant: 'section',
    padding: 'none'
  }
});

export type SurfaceVariant = VariantProps<typeof surfaceVariants>['variant'];
export type SurfacePadding = VariantProps<typeof surfaceVariants>['padding'];

export type SurfaceProps = WithElementRef<HTMLAttributes<HTMLElement>> & {
  /** Rendered element. Use `aside`, `section`, `nav`, … to keep semantics. */
  as?: string;
  variant?: SurfaceVariant;
  padding?: SurfacePadding;
};
