module.exports = {
  '*.{js,ts,mjs,cjs,svelte,json,html,css,md}': [
    'prettier --check --config .config/prettier/.prettierrc.json --ignore-path .config/prettier/.prettierignore'
  ],
  // Theme guardrail — see docs/theming.md. Runs on the staged files only, so
  // a commit that reintroduces a raw palette utility or colour literal fails
  // here rather than at pre-push.
  'src/**/*.{svelte,css,ts}': ['node src-tauri/scripts/lint-theme.mjs']
};
