export default {
  extends: [
    '@commitlint/config-conventional',
  ],
  ignores: [(message) => message.toLowerCase().includes('bump')],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'refactor',
        'test',
      ],
    ],
  },
};
