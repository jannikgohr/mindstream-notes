export const recoveryStatus = $state({
  unavailable: false,
  copies: [] as { key: string; raw: string; reason: string }[]
});
