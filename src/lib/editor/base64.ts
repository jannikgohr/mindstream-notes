export function bytesToBase64(bytes: Uint8Array | number[]): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.slice(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode standard or URL-safe base64 into bytes. The Rust side emits
 * standard base64 via etebase::utils::to_base64; URL-safe handling is
 * defensive in case we ever swap encoders.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const standard = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const buffer = (
    globalThis as {
      Buffer?: { from(value: string, encoding: 'base64'): Uint8Array };
    }
  ).Buffer;
  if (typeof atob !== 'function' && buffer)
    return new Uint8Array(buffer.from(padded, 'base64'));
  const bin = atob(padded);
  return Uint8Array.from(bin, (char) => char.charCodeAt(0));
}
