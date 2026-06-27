# Contributing

AgentOJ accepts public benchmark-submission work through small, reviewable pull requests.

## Public PR submissions

1. Copy `.agentoj/submission.example.json` to `.agentoj/submission.json`.
2. Put the unified diff in `.agentoj/submission.patch`.
3. Keep the patch limited to the problem's declared editable files.
4. Do not include secrets, private logs, raw chain-of-thought, stdout/stderr dumps, or local paths.

The PR judge runs trusted default-branch code, checks out only `.agentoj` submission files from the PR, and writes a sanitized summary artifact/comment.

## Demo-public and scored-hidden problem contracts

Public fixtures in this repository are demo-public unless a problem explicitly declares `scoringMode: "scored-hidden"`. Demo-public fixtures are useful for OSS review, adapter smoke, and UI/API demos, but they must not be presented as scored benchmark results.

Scored-hidden problems require private or safe-generated oracle metadata before any public score claim: `oracleMetadata.kind` must be `hidden-fixture` or `generated-private`, `hiddenRequired` must be `true`, `oracleDescriptorHash` must be an opaque SHA-256 reference, and `originalEvidenceId` and `rerunEvidenceId` must identify distinct executions. Do not commit hidden oracle paths, cases, expected outputs, temp paths, result bundles, prompt/token bundles, or raw runner logs.


## Development checks

```bash
npm test
npm run smoke:deploy
```

## Runtime dependency update process

- Node/package updates: update `package.json` and `package-lock.json` together, run focused tests, then `npm test`.
- GitHub Actions updates: resolve the upstream tag to a full commit SHA, update workflow `uses:` pins, and keep structural workflow tests passing.
- Docker image updates: record the upstream tag, resolved digest, registry source, reason for the update, and a Docker smoke result. Adapter images must stay `image@sha256:<digest>`.
- Scored oracle updates: keep hidden/generated oracle data private, update only opaque descriptor hashes and distinct original/rerun evidence ids, and include Docker rerun evidence in the review notes.

## Review expectations

- Prefer allowlists and explicit DTOs over redaction-only public surfaces.
- Keep public UI static/read-only by default.
- Do not broaden workflow permissions or public API write access without a dedicated plan and tests.
- Treat Docker sandbox success, independent rerun evidence, hidden-oracle metadata, and redaction checks as release gates for any scored benchmark claim.
