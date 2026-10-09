// commitlint configuration for dsh-orquestrator.
//
// Enforces Conventional Commits (https://www.conventionalcommits.org/) — the
// same format the repository gates expect. Wired to the `commit-msg` git hook
// via husky (see .husky/commit-msg and CONTRIBUTING.md): invalid messages are
// rejected at commit time.
//
// This file is CommonJS on purpose: the package is `"type": "module"`, so a
// plain `.js` config would be loaded as ESM and `module.exports` would throw.
//
// Rules use the [level, applicable, value] form: 2 = error, 'always' = enforce.
module.exports = {
  // Start from the community-standard preset: type-enum, type-empty,
  // subject-empty, header-max-length, body-leading-blank, ...
  extends: ['@commitlint/config-conventional'],

  rules: {
    // Only these types are allowed; they map 1:1 to the changelog sections and
    // to the release notes.
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],

    // The subject may start upper- or lower-case and keeps mid-sentence
    // capitals for proper nouns and acronyms ("... and Cancel that aborts the
    // send", "... the DSH checkout") — the repository's own history speaks like
    // that. What is banned: SHOUTING, Start Case And PascalCase.
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],

    // Keep the commit header short enough for git log --oneline, the GitHub UI
    // and release notes. Use the body for details; put breaking changes in the
    // `BREAKING CHANGE:` footer.
    'header-max-length': [2, 'always', 72],
  },
};
