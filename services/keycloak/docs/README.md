# Keycloak

OIDC identity provider for Headlamp and Grafana. Runtime source is the pinned upstream Keycloak distribution; `src/entrypoint.sh` supplies runtime configuration from tmpfs. Passwords and client secrets belong in Lockbox, never in repository YAML or images.

Build on the developer machine or GitHub Actions only. `make build-keycloak` builds the optimized runtime image. The common Deploy production workflow accepts `service=keycloak`: it builds on GitHub Actions, verifies identical images in both private registries, deploys by immutable digest to YC then home, and records per-service rollback history. The operator must refresh the installed CD gate and resource identifiers before the first deployment. OIDC rollout is still in progress; these configurations alone do not enable login.

Two-site clustering, realm initialization and application role bindings must be verified before enabling login. WebAuthn enrollment requires the account owner's browser interaction.
