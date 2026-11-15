export async function invokeTauri<T>(
  client: WebdriverIO.Browser,
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return client.execute(
    async (cmd: string, invokeArgs: Record<string, unknown> | undefined) => {
      const tauri = window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke?: <R>(
            command: string,
            args?: Record<string, unknown>
          ) => Promise<R>;
        };
      };
      const invoke = tauri.__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error('Tauri invoke is not exposed in WebView');
      return invoke(cmd, invokeArgs);
    },
    command,
    args
  ) as Promise<T>;
}
