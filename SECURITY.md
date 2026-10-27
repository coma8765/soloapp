# Security

This project is an experimental reference deployment, not a security-certified identity provider. Public registration is enabled, user roles are not implemented, and disaster recovery requires separate backups.

Do not put credentials, private keys, kubeconfigs, Lockbox payloads, production inventory or personal access tokens in commits/issues/logs. The examples contain placeholders only. Keep production inventory and cloud resources in the ignored local paths described in README. Use separate workload identities and short-lived credentials; secrets are delivered from Lockbox to RAM.

Before publishing, run `make public-check`. A clean scanner result is evidence from configured detection rules, not a guarantee that arbitrary sensitive information cannot be present. If a credential was exposed, revoke/rotate it first; adding .gitignore does not remove it from history.

For a vulnerability, use the repository's private security reporting facility when enabled. Do not disclose working credentials or exploit details in a public issue. There is no promised response SLA.
