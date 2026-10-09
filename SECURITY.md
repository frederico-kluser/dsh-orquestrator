# Security Policy

Security is a first-class concern for **dsh-orquestrator** (`frederico-kluser/dsh-orquestrator`). Thank you for
helping keep the project and its users safe.

## Supported Versions

Only the latest release line receives security fixes. Please upgrade before reporting issues that
may already be fixed.

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest release (`main`) | :white_check_mark: |
| Previous minor (n-1) | :white_check_mark: (best effort) |
| Older versions     | :x:                |

## Reporting a Vulnerability

**Do not report security vulnerabilities through public issues, discussions, or pull requests.**

We use GitHub **Private Vulnerability Reporting**:

1. Open the repository's **Security** tab → **Advisories** → **Report a vulnerability**
   (<https://github.com/frederico-kluser/dsh-orquestrator/security/advisories/new>).
2. Alternatively, email **kluserhuu@gmail.com** with a descriptive subject, a detailed report, and your
   preferred credit name.

Please include, whenever possible:

- Description of the vulnerability and its potential impact.
- Step-by-step reproduction or a proof of concept.
- Affected versions/commit hashes and, if known, the introducing commit.
- Any suggested fix or mitigation.

### Our SLA

| Milestone                                | Target                      |
| ---------------------------------------- | --------------------------- |
| Acknowledgement of your report           | **48 hours**                |
| Triage and initial severity assessment   | **3 business days**         |
| Status updates                           | every **7 days**            |
| Fix or mitigation for critical findings  | **30 days**                 |
| Fix or mitigation for other findings     | **90 days**                 |

If a report is out of scope or not accepted, we will explain why and, where relevant, point you to
the appropriate channel.

## Coordinated Disclosure

- Please keep the vulnerability **confidential** until a fix is released and a public advisory is
  published.
- We will work with you on a disclosure date, credit you in the advisory (unless you prefer to
  remain anonymous), and notify you when the fix ships.
- **Embargo**: up to **90 days** from acknowledgement; we will never extend an embargo without your
  agreement and will always aim to disclose as soon as a fix is available.
- Once a fix is released, we publish a GitHub Security Advisory (CVE when applicable) and a release
  note referencing the fix.

## Scope

In scope:

- The `dsh-orquestrator` codebase, its published packages, and the build/release pipelines of this
  repository.

Out of scope (report to the relevant vendor instead):

- Vulnerabilities in third-party dependencies with an existing upstream advisory.
- Issues exclusively affecting unsupported versions.
- Social engineering, physical attacks, and denial of service against GitHub or third-party
  infrastructure.

## Hardening

The project maintains the following supply-chain protections; keep them enabled:

- **Secret scanning** and **push protection** (GitHub secret scanning) to prevent credential leaks.
- **Dependabot** alerts and version updates for vulnerable dependencies (`.github/dependabot.yml`).
- **Rulesets** on `main` (`.github/rulesets/regras-main.json`): pull requests required, no
  force-push or deletion, linear (squash-only) history, and the `verify` status check green and up
  to date before merging. Required approvals stay at zero while the project has a single maintainer
  and get raised (with code owner review) when a second maintainer joins.
- **Immutable release tags** (`.github/rulesets/regras-tags.json`): `v*` tags can never be moved or
  deleted.
- **OpenSSF Scorecard** monitoring (`scorecard.yml`) with published results.
- **Pinned GitHub Actions** (`owner/repo@<PIN_SHA>`) so that third-party action tags cannot be
  moved underneath us.

## Contact

- Security contact: **kluserhuu@gmail.com**
- Public non-security questions: use GitHub issues/discussions in `frederico-kluser/dsh-orquestrator`.
