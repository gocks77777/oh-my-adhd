# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.31] - 2026-05-31

### Added
- Continuous Integration via GitHub Actions (`test` matrix on Node 18/20/22): type-check, build, and full test suite.
- `CONTRIBUTING.md` with local dev workflow and PR checklist.
- `CHANGELOG.md` (this file).
- Issue templates for bug reports and feature requests.
- Integration tests for the `init` and `doctor` CLI commands (`bin/oh-my-adhd.mjs`).
- Unit tests for the shared `parseLastCapture` signal parser.

### Fixed
- **Critical:** Stop hook was repeatedly blocking even after `wiki_dump` was called.
  Root cause: the published v0.2.30 tarball shipped a stale `dist/` where `brain.js`
  still wrote `.last-dump-${ppid}` (old PPID scheme), while `stop-hook.mjs` expected
  `.last-dump` (new single-file scheme). They never matched, so the stop hook always
  saw "no dump this session". Fixed by rebuilding dist before publish.
- Replaced PPID-based per-session files (`.session-start-${ppid}`, `.last-dump-${ppid}`)
  with single shared files (`.session-start`, `.last-dump`). The old scheme broke
  Stop hook session matching when hooks ran via `npx` because the intermediate
  `npm exec` process produced a different PID on every invocation.
- `session-recall.mjs` now GC-migrates legacy PPID-based session files on first run.
- Removed dead `readdirSync` import from `stop-hook.mjs`.
- `init` now registers hooks as `npx --yes oh-my-adhd session-recall` / `stop-hook`
  subcommands, so hook paths survive `npx` cache clears.
- `doctor` SessionStart hook detection updated to match the new `npx` subcommand format.

### Changed
- Refactored the duplicated "parse last capture into signal fields" logic that
  was copy-pasted across `wiki-recall`, `getThreads`, and `consolidate` into a
  single exported `parseLastCapture` helper in `brain.ts`. No behavior change.
- README `wiki_recall` description corrected: automatic context restore is handled
  by the SessionStart hook; `wiki_recall` is for on-demand deeper searches.
- README MCP tool table now lists `wiki_export` / `wiki_import`, and the
  SessionStart demo matches the actual `session-recall.mjs` output.

## [0.2.30] - 2026-05-30

### Fixed
- `doctor` SessionStart hook detection now checks for `session-recall.mjs`
  (or legacy `.session-start`) instead of the removed `mcp_tool` wiki_recall hook.
- `init` registers `session-recall.mjs` as the SessionStart hook, replacing the
  inline timestamp-only command and injecting recall context on startup.
- Renamed `SYSTEM_SENSITIVE_DIRS`, used POSIX separators in the absolute
  denylist, and tightened the sensitive-path tests.

## [0.2.27 - 0.2.29]

### Security
- Expanded the system path denylist (sudoers, shadow, ssh, ssl) with macOS
  `/private/etc/*` canonical paths and case-folded matching for APFS.
- Fixed a TOCTOU window in sensitive-path resolution.

## [0.2.21 - 0.2.26]

### Fixed
- Normalized `updatedAt` to ISO across import paths; added NaN guards.
- Sorted the manifest after import; added sort-order regression tests.
- Corrected GitHub repository URLs and author metadata.

## [0.2.1 - 0.2.20]

### Added
- `wiki_export` / `wiki_import` for portable brain backups.
- Auto-consolidation of threads untouched for 30+ days into keyword summaries.
- Git context anchoring appended to every `wiki_dump`.
- Cross-process manifest file lock plus in-process serialization.

## [0.2.0] - initial release

### Added
- ADHD second brain MCP plugin for Claude Code: `wiki_recall`, `wiki_dump`,
  `wiki_unstick`, plus the wiki page/graph toolset.
- One-line `npx oh-my-adhd init` setup (MCP registration + SessionStart/Stop hooks).
- `npx oh-my-adhd doctor` self-diagnostics.

[Unreleased]: https://github.com/gocks77777/oh-my-adhd/compare/v0.2.30...HEAD
[0.2.30]: https://github.com/gocks77777/oh-my-adhd/releases/tag/v0.2.30
