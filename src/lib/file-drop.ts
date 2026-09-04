/** True when an HTML drag carries files from outside the app. */
export function isFileDrag(event: DragEvent): boolean {
  const transfer = event.dataTransfer;
  return Boolean(
    transfer &&
    (transfer.files.length > 0 || Array.from(transfer.types).includes('Files'))
  );
}

/** Files that the app can currently import as notes. */
export function droppedPdfFiles(event: DragEvent): File[] {
  return Array.from(event.dataTransfer?.files ?? []).filter(
    (file) =>
      file.type.toLowerCase() === 'application/pdf' ||
      file.name.toLowerCase().endsWith('.pdf')
  );
}
