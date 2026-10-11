import { toErrorMessage } from '$lib/api/errors';
import { pushToast } from '$lib/components/toast.svelte';
import { tUiFormat } from '$lib/settings/i18n.svelte';
import { importPdfIn } from '$lib/stores/tree.svelte';

/**
 * Import dropped PDFs as notes under `parentId` (null = the vault root) and
 * open the last one that made it in. A failure stops the batch and is reported,
 * but whatever imported before it is kept and opened.
 */
export async function importDroppedPdfs(
  files: readonly File[],
  parentId: string | null,
  open: (noteId: string) => void | Promise<void>
): Promise<void> {
  let lastImportedId: string | null = null;
  try {
    for (const file of files) {
      lastImportedId = await importPdfIn(parentId, file);
    }
  } catch (err) {
    pushToast(tUiFormat('fileDrop.failed', { error: toErrorMessage(err) }), {
      variant: 'error'
    });
  }
  if (lastImportedId) await open(lastImportedId);
}
