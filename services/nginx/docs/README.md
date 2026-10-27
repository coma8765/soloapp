# Authentication gateway

Independent Kubernetes Deployment with two replicas per site. The configurable image defaults to `nginx:1.28-alpine`; the optional Dockerfile creates an equivalent non-root image. No application secrets are baked into images.

The gateway performs `auth_request` through the auth ClusterIP Service, overwrites identity headers, and forwards `/user-id` to the whoami ClusterIP Service. NetworkPolicy permits these internal connections only from gateway pods. NodePort is restricted before DNAT to WireGuard/local ingress traffic and requires a client certificate.

Internal pod-to-Service HTTP is confined to each single-node cluster by NetworkPolicy; it is not mTLS. External ingress-to-gateway and PostgreSQL connections retain TLS. Application secrets remain in memory from scoped Lockbox identities.
