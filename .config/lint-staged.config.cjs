module.exports = {
  '*.{js,ts,mjs,cjs,svelte,json,html,css,md}': [
    'prettier --check --config .config/prettier/.prettierrc.json --ignore-path .config/prettier/.prettierignore'
  ]
};
