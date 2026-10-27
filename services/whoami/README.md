# whoami deployment and public contract

The production whoami image now runs the NestJS application in `../app-api`.
This directory owns the stable public OpenAPI contract, Kubernetes identity,
Service, deployment configuration and Makefile entry points. The C++ implementation was removed; its source remains in Git history and
previous release images remain in the registry for rollback.
Runtime unit and HTTP tests live in `../app-api/src` and `../app-api/test`.

Run `make build-whoami`, `make test-whoami`, `make codegen-whoami` from the root.
See [NestJS runtime documentation](../app-api/README.md).
