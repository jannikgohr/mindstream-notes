module.exports = {
    extends: ['@commitlint/config-conventional'],
    rules: {
        'scope-empty': [2, 'never'],
        'scope-case': [2, 'always', 'lower-case'],
        'type-case': [2, 'always', 'lower-case'],
        'body-max-line-length': [0, 'always']
    },
};