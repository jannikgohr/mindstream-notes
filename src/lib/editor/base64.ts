/**
 * Decode standard or URL-safe base64 into bytes. The Rust side emits
 * standard base64 via etebase::utils::to_base64; URL-safe handling is
 * defensive in case we ever swap encoders.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const standard = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
