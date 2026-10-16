/** Track accepted writes until they settle, including writes queued while draining. */
export function createPersistenceDrain() {
  const pending = new Set<Promise<unknown>>();
  function track<T>(task: Promise<T>): Promise<T> {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task)
    );
    return task;
  }
  async function flush(): Promise<void> {
    let failure: PromiseRejectedResult | undefined;
    while (pending.size) {
      const results = await Promise.allSettled([...pending]);
      failure ??= results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected'
      );
    }
    if (failure) throw failure.reason;
  }
  return { track, flush };
}
