import { expect, test, type Locator, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { clickFileTreeCreateAction } from './file-tree-toolbar';

// A wide desktop keeps every drawing toolbar available while both sidebars move.
test.use({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });

type EditorKind =
  | 'markdown-wysiwyg'
  | 'markdown-source'
  | 'markdown-split'
  | 'freeform'
  | 'ink'
  | 'pdf-reader'
  | 'pdf-handwriting'
  | 'kanban';

interface EditorSession {
  surfaces: Locator[];
  scrollbars: Locator[];
  checkState(): Promise<void>;
  changeTools(): Promise<void>;
}

async function createNote(page: Page, action: string, draftLabel = action) {
  await clickFileTreeCreateAction(page, action);
  const draft = page.getByRole('textbox', { name: draftLabel, exact: true });
  await draft.fill('Stability regression');
  await draft.press('Enter');
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: 'Stability regression', exact: true })
    .click();
}

async function importPdf(page: Page) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i++) {
    pdf
      .addPage([595, 842])
      .drawText(`Stability PDF page ${i}`, { x: 50, y: 700, font });
  }
  const transfer = await page.evaluateHandle(
    (bytes) => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(bytes)], 'Stability PDF.pdf', {
          type: 'application/pdf'
        })
      );
      return data;
    },
    Array.from(await pdf.save())
  );
  await page
    .getByRole('banner')
    .dispatchEvent('dragover', { dataTransfer: transfer });
  await page
    .getByRole('banner')
    .dispatchEvent('drop', { dataTransfer: transfer });
  await page
    .getByRole('group', { name: 'File tree' })
    .getByRole('button', { name: 'Stability PDF', exact: true })
    .click();
  await expect(page.locator('.pdf-page-scroller')).toBeVisible();
}

async function openEditor(
  page: Page,
  kind: EditorKind
): Promise<EditorSession> {
  await page.goto('/');
  await expect(
    page
      .getByRole('group', { name: 'File tree' })
      .getByRole('button', { name: 'Welcome', exact: true })
  ).toBeVisible();
  const panel = page.getByRole('tabpanel');
  // Start above the handle's 245px floor; the seeded sidebar is only 240px.
  await dragSidebar(page, 'left', 40);

  if (kind.startsWith('markdown-')) {
    const mode = kind.replace('markdown-', '');
    const modeButton = panel.getByRole('button', {
      name: /^Editor view mode:/
    });
    if (mode !== 'wysiwyg') await modeButton.click();
    if (mode === 'split') await modeButton.click();
    const source = panel.locator('.cm-content');
    const rich = panel.locator('.ProseMirror');
    const editor = mode === 'wysiwyg' ? rich : source;
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(
      Array.from({ length: 80 }, (_, i) => `Stability line ${i + 1}`).join(
        '\n\n'
      )
    );
    await expect(editor).toContainText('Stability line 80');
    const surfaces = mode === 'split' ? [source, rich] : [editor];
    const scrollbars = [
      mode === 'wysiwyg'
        ? panel.locator('.themed-scrollbar:has(.ProseMirror)')
        : panel.locator('.cm-scroller')
    ];
    for (const scrollbar of scrollbars) {
      await scrollbar.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(() => scrollbar.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(100);
    }
    return {
      surfaces,
      scrollbars,
      checkState: async () => {
        await expect(editor).toContainText('Stability line 80');
      },
      changeTools: async () => {
        for (const name of ['Bold', 'Italic', 'Bold', 'Italic']) {
          await panel.getByRole('button', { name, exact: true }).click();
        }
      }
    };
  }

  if (kind === 'freeform') {
    await createNote(page, 'New drawing canvas');
    const surface = panel.locator('.excalidraw');
    await expect(surface).toBeVisible();
    await surface.getByRole('button', { name: 'Zoom in', exact: true }).click();
    const zoom = surface.locator('.reset-zoom-button');
    const before = await zoom.innerText();
    return {
      surfaces: [surface, surface.locator('canvas.interactive')],
      scrollbars: [],
      checkState: async () => {
        await expect(zoom).toHaveText(before);
      },
      changeTools: async () => {
        for (const name of [
          /^Rectangle$/,
          /^Arrow$/,
          /^Hand \(panning tool\)/,
          /^Selection$/
        ]) {
          const tool = surface.getByRole('radio', { name });
          await tool.locator('..').click();
          await expect(tool).toBeChecked();
        }
      }
    };
  }

  if (kind === 'kanban') {
    await createNote(page, 'New Kanban board', 'New note');
    const surface = panel.locator('.kanban-scope');
    await expect(
      panel.getByRole('toolbar', { name: 'Kanban board toolbar' })
    ).toBeVisible();
    await page.keyboard.press('Control+f');
    const query = page.getByPlaceholder('Search Kanban cards');
    await query.fill('keep this filter');
    return {
      surfaces: [surface, query],
      scrollbars: [],
      checkState: async () => {
        await expect(query).toHaveValue('keep this filter');
      },
      changeTools: async () => {
        const filter = page
          .getByLabel('Kanban filters')
          .getByRole('button')
          .first();
        await filter.click();
        await expect(filter).toHaveAttribute('aria-pressed', 'true');
        await filter.click();
        await expect(filter).toHaveAttribute('aria-pressed', 'false');
      }
    };
  }

  if (kind.startsWith('pdf-')) await importPdf(page);
  else await createNote(page, 'New handwritten note');

  if (kind === 'pdf-reader') {
    const scroller = panel.locator('.pdf-page-scroller');
    const number = panel.getByRole('textbox', {
      name: 'Page number',
      exact: true
    });
    await number.fill('3');
    await number.press('Enter');
    await expect(number).toHaveValue('3');
    await expect
      .poll(async () => {
        const target = (await scroller
          .locator('figure[data-page-number="3"]')
          .boundingBox())!;
        const viewport = (await scroller.boundingBox())!;
        return target.y - viewport.y;
      })
      .toBeCloseTo(16, 0);
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(500);
    return {
      surfaces: [scroller],
      scrollbars: [scroller],
      checkState: async () => {
        await expect(number).toHaveValue('3');
      },
      changeTools: async () => {
        for (const name of ['Highlight', 'Comment', 'Select']) {
          const tool = panel.getByRole('button', { name, exact: true });
          await tool.click();
          await expect(tool).toHaveAttribute('aria-pressed', 'true');
        }
      }
    };
  }

  if (kind === 'pdf-handwriting')
    await panel.getByRole('button', { name: 'Pen', exact: true }).click();
  const canvas = panel.getByLabel(
    kind === 'ink' ? 'Handwritten note canvas' : 'Handwriting',
    { exact: true }
  );
  await expect(canvas).toBeVisible();
  await panel.getByRole('button', { name: 'Choose zoom', exact: true }).click();
  await page.getByRole('menuitem', { name: '150%', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: 'Choose zoom', exact: true })
  ).toContainText('150%');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + 200, { steps: 8 });
  await page.mouse.up();
  await expect(
    panel.getByRole('button', { name: 'Undo', exact: true })
  ).toBeEnabled();
  // Undo is enabled before the asynchronous canvas painter necessarily catches
  // up. Wait for the stroke at its known location before capturing the viewport.
  await expect
    .poll(() =>
      canvas.evaluate((el: HTMLCanvasElement) => {
        const ratio = el.width / el.getBoundingClientRect().width;
        const pixels = el
          .getContext('2d')!
          .getImageData(
            el.width / 2 - 10 * ratio,
            140 * ratio,
            100 * ratio,
            80 * ratio
          ).data;
        return pixels.some(
          (value, i) =>
            i % 4 === 0 &&
            value < 80 &&
            pixels[i + 1] < 80 &&
            pixels[i + 2] < 80
        );
      })
    )
    .toBe(true);
  const top = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL());
  await canvas.hover();
  await page.mouse.wheel(0, 650);
  await page.mouse.move(0, 0);
  await expect
    .poll(() => canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL()))
    .not.toBe(top);
  // Let the wheel frame finish before capturing the scrolled viewport.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  const pixels = await canvas.evaluate((el: HTMLCanvasElement) =>
    el.toDataURL()
  );
  return {
    surfaces: [canvas],
    scrollbars: [],
    checkState: async () => {
      await expect(
        panel.getByRole('button', { name: 'Choose zoom', exact: true })
      ).toContainText('150%');
      // Resizing can round the page shadow by a few color levels. A viewport
      // reset moves the page edges and fails this per-channel tolerance.
      await expect
        .poll(() =>
          canvas.evaluate(async (el: HTMLCanvasElement, baseline) => {
            const image = new Image();
            image.src = baseline;
            await image.decode();
            if (image.width !== el.width || image.height !== el.height)
              return 255;
            const reference = document.createElement('canvas');
            reference.width = el.width;
            reference.height = el.height;
            const context = reference.getContext('2d')!;
            context.drawImage(image, 0, 0);
            const before = context.getImageData(0, 0, el.width, el.height).data;
            const after = el
              .getContext('2d')!
              .getImageData(0, 0, el.width, el.height).data;
            let difference = 0;
            for (let i = 0; i < before.length; i++) {
              difference = Math.max(difference, Math.abs(before[i] - after[i]));
            }
            return difference;
          }, pixels)
        )
        .toBeLessThanOrEqual(4);
    },
    changeTools: async () => {
      for (const name of ['Eraser', 'Lasso select', 'Pen']) {
        const tool = panel.getByRole('button', { name, exact: true });
        await tool.click();
        await expect(tool).toHaveAttribute('aria-pressed', 'true');
      }
    }
  };
}

async function dragSidebar(page: Page, side: 'left' | 'right', delta: number) {
  const handle = page.getByRole('separator', {
    name: `Resize ${side} sidebar`,
    exact: true
  });
  const before = (await handle.boundingBox())!;
  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    before.x + before.width / 2 + delta,
    before.y + before.height / 2,
    { steps: 8 }
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await handle.boundingBox())!.x)
    .toBeCloseTo(before.x + delta, 0);
}

async function resizeSidebar(page: Page, side: 'left' | 'right') {
  const delta = side === 'left' ? 80 : -80;
  await dragSidebar(page, side, delta);
  await dragSidebar(page, side, -delta);
}

async function refreshPluginRegistry(page: Page) {
  // Browser settings do not emit native plugins-changed events. Toggling the
  // bundled plugin exercises the same reactive registry dependency through UI.
  await page
    .getByRole('button', { name: 'Open settings', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: 'Plugins', exact: true })
    .first()
    .click();
  const enabled = dialog.getByRole('switch', {
    name: 'Enable in this vault',
    exact: true
  });
  await enabled.click();
  await expect(enabled).toHaveAttribute('aria-checked', 'false');
  await enabled.click();
  await expect(enabled).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

for (const kind of [
  'markdown-wysiwyg',
  'markdown-source',
  'markdown-split',
  'freeform',
  'ink',
  'pdf-reader',
  'pdf-handwriting',
  'kanban'
] as const) {
  test(`${kind} survives sidebar resizing, tool changes, and registry refreshes`, async ({
    page
  }) => {
    test.setTimeout(60_000);
    const session = await openEditor(page, kind);
    const nodes = await Promise.all(
      session.surfaces.map((surface) => surface.elementHandle())
    );
    expect(nodes.every(Boolean)).toBe(true);
    const probe = await page.evaluateHandle((nodes) => {
      const detached: number[] = [];
      const inspect = () =>
        nodes.forEach((node, index) => {
          if (!node!.isConnected && !detached.includes(index))
            detached.push(index);
        });
      const observer = new MutationObserver(inspect);
      observer.observe(document.body, { childList: true, subtree: true });
      return { detached, inspect, stop: () => observer.disconnect() };
    }, nodes);
    const scrollPositions = await Promise.all(
      session.scrollbars.map((el) => el.evaluate((node) => node.scrollTop))
    );
    const assertStable = async () => {
      expect(
        await probe.evaluate((probe) => {
          probe.inspect();
          return probe.detached;
        }),
        'Original editor surfaces were detached'
      ).toEqual([]);
      for (let i = 0; i < session.scrollbars.length; i++) {
        expect(
          await session.scrollbars[i].evaluate((node) => node.scrollTop)
        ).toBeCloseTo(scrollPositions[i], 0);
      }
      await session.checkState();
    };
    try {
      for (const side of ['left', 'right'] as const) {
        await test.step(`resize ${side} sidebar and restore its width`, async () => {
          await resizeSidebar(page, side);
          await page.mouse.move(0, 0);
          await assertStable();
        });
      }
      await test.step('change editor tools', async () => {
        await session.changeTools();
        await page.mouse.move(0, 0);
        await assertStable();
      });
      await test.step('refresh the plugin registry and wait through settings/autosave work', async () => {
        await refreshPluginRegistry(page);
        // Guard the delayed reset as well as immediate DOM replacements.
        await page.waitForTimeout(1200);
        await assertStable();
      });
    } finally {
      // Cleanup must not mask an assertion when a timed-out page is closing.
      await probe.evaluate((probe) => probe.stop()).catch(() => {});
    }
  });
}
