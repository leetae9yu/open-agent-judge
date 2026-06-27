## Summary

- 

## Verification

- [ ] `npm test`
- [ ] Focused tests for changed surface:
- [ ] Public data/redaction surfaces checked when applicable

## Security and public-surface checklist

- [ ] No secrets, raw chain-of-thought, raw patch text, stdout/stderr dumps, local paths, or tokens are added to public outputs.
- [ ] Workflow permissions remain least-privilege.
- [ ] GitHub Actions remain pinned to full commit SHAs.
- [ ] Docker images remain digest-pinned.
- [ ] Public UI remains static/read-only by default.

## Notes

