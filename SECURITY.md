# Credential safety

This repository uses local Git hooks and a read-only GitHub Actions secret scan.
These controls reduce accidental key exposure; they are not a guarantee that all
vulnerabilities or all secret formats have been detected.

## Enable protection on each developer computer

From the repository folder, after pulling these changes:

```bash
npm ci --ignore-scripts
npm run security:setup
npm run security:history
```

`security:setup` downloads Gitleaks 8.30.1 from its official GitHub release,
checks a SHA-256 digest pinned in source, and explicitly activates the existing
Husky hooks. Node.js >=22.13.0, Git, and tar are required; the installer supports
Windows 10/11, macOS, and Linux (x64/arm64). Linux x64 is covered by CI; other
platforms must be checked on the developer's machine. Do not disable hooks to
work around an installation or scan error.

- Before commit: scan the **staged content**, including partially staged files;
  refuse environment/private-key files even when force-added; then run the
  existing unit tests.
- Before push: scan the full history of locally available branches/tags,
  including merge diffs. Shallow clones fail until full history is fetched.
- On GitHub: a separate `Secret scan` check runs on pushes and pull requests.
  Keys are redacted; scan reports containing secret values are not uploaded.
- A separate `Runtime dependency audit` check runs `npm audit --omit=dev` on
  pushes/PRs and fails for known production dependency advisories. It depends
  on the npm advisory database and does not establish runtime exploitability.
- Default Gitleaks provider rules are retained, with an additional rule for
  KOSIS and public-data credential variable names. The single documented
  historical example in `.gitleaksignore` is excluded by exact fingerprint only.

`.env.example` may be committed with placeholders, never real values. Put real
credentials in local environment files or the deployment provider's secret
manager. `.gitignore` does not remove files that were already committed.

## Repository administrator settings (separate from code)

In GitHub **Settings → Advanced Security**, enable **Secret Protection / secret
scanning** and **Push protection** when available. Then protect `main` with a
ruleset requiring `Secret scan`, `Runtime dependency audit`, and existing CI checks before merge. These
settings are not enabled merely by adding this file or the workflow.

GitHub Actions runs **after upload**, so it cannot retract a leaked key from a
public repository. Local hooks can be skipped; server-side push protection is
an important additional layer. Feature coverage varies by key format and plan.

## If a key is exposed

1. Revoke/rotate it at the issuing provider first, then update deployment secrets.
2. Review usage and billing logs for unexpected access.
3. Remove it from current files. Coordinate any history rewriting with all
   contributors; deleting a line or making the repository private is not enough.
4. Re-scan branches/tags and check PRs, Actions logs, artifacts, and releases.

Do not publish a secret in an issue, PR, screenshot, or scan report. Contact the
owner privately (or use a private security advisory if enabled). For scanner
false positives, record the reviewed reason and the narrowest possible exception.
Never exempt entire documentation/test directories or disable a detection rule.

References: [Gitleaks](https://github.com/gitleaks/gitleaks),
[GitHub push protection](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/prevent-future-leaks/enable-push-protection).
