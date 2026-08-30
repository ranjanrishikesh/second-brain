# Contributing

Thank you for helping improve the portable second-brain template.

## Before you start

- Search existing issues before opening a new one.
- Use the bug or capability-request template when it applies.
- Report security vulnerabilities privately as described in [the security policy](.github/SECURITY.md).

## Development workflow

1. Use Node.js 22.13 or newer and pnpm 10.9.
2. Install dependencies with `pnpm install --frozen-lockfile`.
3. Create a focused branch and keep changes narrowly scoped.
4. Add or update tests when behavior changes.
5. Run `pnpm verify:fast`; run the full relevant verification when changing schemas, builds, or end-to-end behavior.
6. Open a pull request that explains the change and the checks you ran.

## Privacy and content safety

Use synthetic, redistributable fixtures. Do not submit private brain sources, source excerpts, generated private wiki content, personal filenames, local paths, credentials, secrets, or third-party material you do not have permission to redistribute. Sanitize logs and screenshots before attaching them.

By submitting a contribution, you agree that it may be distributed under this repository's MIT License and that you have the right to submit it.
