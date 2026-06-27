# Security Policy

## Reporting vulnerabilities

Please open a private security advisory or contact the maintainers before publishing exploit details. Include affected commands, workflows, API routes, or static export surfaces and a minimal reproduction when possible.

## Public data policy

AgentOJ public surfaces must not expose secrets, raw chain-of-thought, raw patches, stdout/stderr logs, local filesystem paths, database paths, OAuth/session tokens, CSRF tokens, proxy secrets, or admin tokens.
Public releases must also reject oracle/container/result-bundle/API-origin leaks, hidden test cases or expected outputs, prompt/token bundles, credential-bearing URLs, cloud access keys, JWTs, PEM/private keys, and markdown/HTML-obfuscated secret labels.


## Supported security boundaries

- Public PR judging runs in GitHub Actions with read-only permissions and Docker-only sandboxing.
- GitHub Pages is static/read-only by default.
- Public writes require an external GitHub OAuth BFF with server-side proxy secret and CSRF forwarding.
- Public memory requires automatic checks plus trusted reviewer approval.
- Demo-public fixtures are not scored benchmark evidence; scored-hidden operation requires private or safe-generated oracle metadata with an opaque descriptor hash and distinct original/rerun evidence.
- Public scored judging fails closed when hidden oracle metadata, Docker sandbox execution, independent rerun evidence, or public redaction checks are missing.

## Dependency and runtime updates

Security-sensitive updates to GitHub Actions, Docker images, Node, or package lockfiles must follow `CONTRIBUTING.md` and include the resolved action SHA or Docker digest plus verification evidence.
