// E2E keeps release configuration and bundled plugin AOT, but does not need
// the shipped binary's size-focused, whole-program optimization pass.
export const rustProfileVariables = [
  'CARGO_PROFILE_RELEASE_LTO',
  'CARGO_PROFILE_RELEASE_CODEGEN_UNITS',
  'CARGO_PROFILE_RELEASE_OPT_LEVEL'
] as const;

export function e2eRustBuildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.MINDSTREAM_E2E_PRODUCTION_PROFILE === '1') return { ...env };
  return {
    ...env,
    CARGO_PROFILE_RELEASE_LTO: env.CARGO_PROFILE_RELEASE_LTO ?? 'off',
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS:
      env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS ?? '16',
    CARGO_PROFILE_RELEASE_OPT_LEVEL: env.CARGO_PROFILE_RELEASE_OPT_LEVEL ?? '2'
  };
}
