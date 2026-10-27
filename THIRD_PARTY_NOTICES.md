# Third-party components

Apache-2.0 covers the original Soloapp source, not third-party software downloaded during builds or deployed as separate containers. Existing upstream notices must be retained when distributing their code or binaries. This is a dependency guide, not an exhaustive container SBOM.

| Component | Upstream terms/source |
|---|---|
| Drogon / Trantor | MIT; https://github.com/drogonframework/drogon and its Trantor submodule |
| ODB compiler | GPL-3.0; https://github.com/codesynthesis-com/odb/blob/master/LICENSE |
| libodb / libodb-pgsql / libodb-boost | GPL-2.0-only or commercial license; same upstream license index |
| PostgreSQL / libpq | PostgreSQL License; https://www.postgresql.org/about/licence/ |
| libsodium | ISC; https://github.com/jedisct1/libsodium/blob/master/LICENSE |
| Boost | Boost Software License 1.0; https://www.boost.org/LICENSE_1_0.txt |
| PyYAML | MIT; https://github.com/yaml/pyyaml/blob/main/LICENSE |
| Testsuite | Upstream license: https://github.com/yandex/yandex-taxi-testsuite |

Other OS packages and separately deployed nginx, HAProxy, pg_auto_failover, Kubernetes/k3s, Prometheus, Grafana, Loki and Alloy have their own upstream notices. Consult licenses in the exact downloaded versions before redistributing images.

## ODB and distribution

The current build links ODB runtime libraries installed from Ubuntu packages. The upstream license index lists these runtimes as GPL-2.0-only or commercial. Apache-2.0 and GPL-2.0 are not generally compatible; see https://www.apache.org/licenses/GPL-compatibility.html . Publishing original project source under Apache-2.0 does not relicense ODB or establish permission to distribute the combined executable under Apache-2.0. Binary/image distribution requires an applicable ODB license arrangement or a compatible distribution design. No such commercial entitlement is included or assumed here. CI builds for validation and does not publish images.
