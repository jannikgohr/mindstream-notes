/**
 * Open the browser's file picker. The input stays in the document while the
 * picker is open, because some browsers drop the change event of a detached
 * one. Resolves with `null` when the user cancels.
 */
export function pickFiles(
  configure: (input: HTMLInputElement) => void
): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    configure(input);
    document.body.append(input);
    const finish = (files: File[] | null) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () =>
      finish(Array.from(input.files ?? []))
    );
    input.addEventListener('cancel', () => finish(null));
    input.click();
  });
}
