import {
  assertRecord,
  assertString,
  invokeOrFallback,
  TauriCommandName
} from './core';

export interface VaultCollabSigningMaterial {
  username: string;
  publicKeyB64: string;
  privateKeyPkcs8B64: string;
}

function parseMaterial(value: unknown): VaultCollabSigningMaterial {
  const record = assertRecord(value, 'vault signing material');
  return {
    username: assertString(record.username, 'signing username'),
    publicKeyB64: assertString(record.publicKeyB64, 'signing public key'),
    privateKeyPkcs8B64: assertString(
      record.privateKeyPkcs8B64,
      'signing private key'
    )
  };
}

function nativeOnly(): never {
  throw new Error('vault signing credentials require native storage');
}

export function getVaultCollabSigningMaterial(
  serverUrl: string,
  username: string
): Promise<VaultCollabSigningMaterial | null> {
  return invokeOrFallback(
    TauriCommandName.GetVaultCollabSigningMaterial,
    { serverUrl, username },
    nativeOnly,
    (value) => (value === null ? null : parseMaterial(value))
  );
}

export function storeVaultCollabSigningMaterial(
  serverUrl: string,
  material: VaultCollabSigningMaterial
): Promise<VaultCollabSigningMaterial> {
  return invokeOrFallback(
    TauriCommandName.StoreVaultCollabSigningMaterial,
    { serverUrl, material },
    nativeOnly,
    parseMaterial
  );
}
