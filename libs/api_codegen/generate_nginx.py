#!/usr/bin/env python3
"""Generate exact public nginx routes from service OpenAPI contracts."""
import argparse
from pathlib import Path
from route_policy import load, operations, require

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ('auth', 'whoami')


def render(root=ROOT):
    routes = {}; rates = {}; verify = None
    for service in SERVICES:
        for path, method, op in operations(load(root / 'services' / service)):
            policy = op['x-route']
            if service == 'auth' and op['operationId'] == 'internal_verify':
                require(method == 'get' and policy['exposure'] == 'internal' and policy['auth'] == 'bearer', 'Session verifier must stay internal GET with bearer auth')
                verify = (path, policy)
            if policy['exposure'] == 'internal':
                continue
            require(path not in ('/healthz', '/_verify') and not path.startswith('/grafana') and not path.startswith('/internal/'), f'Reserved gateway route: {path}')
            if path in routes:
                previous = routes[path]
                require(previous['service'] == service and previous['policy'] == policy, f'{path}: methods sharing a path must share gateway policy')
                previous['methods'].append(method.upper())
            else:
                routes[path] = {'service': service, 'policy': policy, 'methods': [method.upper()]}
            rate = policy['rate_limit']
            if rate:
                name = rate['group']
                require(name not in rates or rates[name] == rate['requests_per_second'], f'Conflicting rate group: {name}')
                rates[name] = rate['requests_per_second']
    require(verify is not None, 'Missing internal session verifier')
    maps = ['# Generated from services/*/docs/api.yaml; DO NOT EDIT.', 'map $uri $observed_route {', '  default /other;', '  /healthz /healthz;', '  / /;', '  ~^/web/releases/ /web/releases/;', '  ~^/grafana/ /grafana/;']
    maps += [f'  {path} {path};' for path in sorted(routes)]
    maps += ['}', 'map $uri $observed_service {', '  default nginx;', '  / web;', '  ~^/web/releases/ web;']
    maps += [f"  {path} {route['service']};" for path, route in sorted(routes.items()) if path != '/ready']
    maps += ['}']
    maps += [f'limit_req_zone $binary_remote_addr zone=api_{group}:10m rate={rps}r/s;' for group, rps in sorted(rates.items())]
    lines = ['# Generated from services/*/docs/api.yaml; DO NOT EDIT.']
    verifier_path, verifier_policy = verify
    lines += ['location = /_verify {', '  internal;', '  proxy_pass http://auth.soloapp.svc.cluster.local:{{ auth_config.port }}' + verifier_path + ';', '  proxy_pass_request_body off;', '  proxy_set_header Content-Length "";', '  proxy_set_header Authorization $http_authorization;', '  proxy_set_header X-Verified-User-Id "";', f"  proxy_connect_timeout {verifier_policy['timeouts']['connect_seconds']}s;", f"  proxy_read_timeout {verifier_policy['timeouts']['read_seconds']}s;", '}']
    for path, route in sorted(routes.items()):
        policy = route['policy']; service = route['service']; rate = policy['rate_limit']
        lines += [f'location = {path} {{', '  if ($request_method !~ ^(' + '|'.join(sorted(route['methods'])) + ')$) { return 405; }', f"  client_max_body_size {policy['max_body_bytes']};"]
        if path == '/ready': lines += ['  access_log off;']
        if rate:
            burst = f" burst={rate['burst']} nodelay" if rate['burst'] else ''
            lines += [f"  limit_req zone=api_{rate['group']}{burst};"]
        # Never accept an identity supplied by an external client.
        lines += ['  proxy_set_header X-User-Id "";']
        if policy['auth'] == 'signed-user':
            lines += ['  auth_request /_verify;', '  auth_request_set $verified_id $upstream_http_x_verified_user_id;', '  auth_request_set $user_signature $upstream_http_x_user_signature;', '  auth_request_set $user_timestamp $upstream_http_x_user_timestamp;', '  proxy_set_header X-Verified-User-Id $verified_id;', '  proxy_set_header X-User-Signature $user_signature;', '  proxy_set_header X-User-Timestamp $user_timestamp;', '  proxy_set_header Authorization "";']
        else:
            lines += ['  proxy_set_header X-Verified-User-Id "";', '  proxy_set_header X-User-Signature "";', '  proxy_set_header X-User-Timestamp "";', '  proxy_set_header Authorization ' + ('$http_authorization;' if policy['auth'] == 'bearer' else '"";')]
        lines += [f"  proxy_connect_timeout {policy['timeouts']['connect_seconds']}s;", f"  proxy_read_timeout {policy['timeouts']['read_seconds']}s;", '  proxy_pass http://' + service + '.soloapp.svc.cluster.local:{{ ' + service + '_config.port }};', '}']
    return {'maps.conf.j2': '\n'.join(maps) + '\n', 'routes.conf.j2': '\n'.join(lines) + '\n'}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--check', action='store_true'); args = parser.parse_args()
    for name, content in render().items():
        target = ROOT / 'services/nginx/deploy/generated' / name
        if args.check:
            require(target.exists() and target.read_text() == content, f'Stale gateway routes: {target}; run make codegen')
        else:
            target.parent.mkdir(parents=True, exist_ok=True); target.write_text(content)


if __name__ == '__main__':
    main()
