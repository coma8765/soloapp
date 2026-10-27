# Soloapp web

Flutter login/registration UI, logout and a protected Whoami check. API clients in `lib/api/generated/` are generated from `services/{auth,whoami}/docs/api.yaml`; do not edit them manually. `lib/api/transport.dart` handles HTTP and safe user-facing errors, without automatic retries for writes. API requests use absolute paths at the current HTTPS origin, including when the page is loaded from a versioned asset directory.

The bearer token lives only in widget memory. Refreshing or closing the tab requires login again. The browser password manager can fill credentials. There is no token in localStorage, URLs, logs or S3.

```sh
make codegen
make -C services/web test
make -C services/web build VERSION=development
```

Use Flutter 3.44.8 and the committed pubspec.lock. `deploy/Dockerfile` builds the small read-only S3 web origin; Flutter static assets are built once by production CI and published separately. The origin checks the manifest hashes and caches the complete active build before becoming ready. There are two pods and a ClusterIP Service in each site, configured by `service_overrides.web`.

Public `/` serves the selected release index, with `no-store`. Assets are under `/web/releases/<git-sha>/` and use immutable caching. Flutter CanvasKit assets are included in the build (`--no-web-resources-cdn`), so rendering does not depend on a third-party CDN. Non-asset routes and undocumented API paths stay 404.

See `infra/object-storage/README.md` for replication, credentials and rollback.
