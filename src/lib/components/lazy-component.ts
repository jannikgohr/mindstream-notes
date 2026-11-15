export function lazyComponent<C>(
  load: () => Promise<{ default: unknown }>
): () => Promise<C> {
  return () => load().then((mod) => mod.default as C);
}
