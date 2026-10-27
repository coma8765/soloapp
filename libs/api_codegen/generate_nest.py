#!/usr/bin/env python3
"""Generate Nest route metadata from the identity service OpenAPI contracts."""
import argparse
import json
from pathlib import Path
from route_policy import load, operations, require
ROOT = Path(__file__).resolve().parents[2]

def render(root=ROOT):
    routes = {}; limits = {}
    for service in ('whoami', 'app-api'):
        for path, method, op in operations(load(root / 'services' / service)):
            require(method == 'get', 'Nest identity contract supports GET only')
            name = op['operationId']
            require(name in ('user_id', 'healthz', 'health_ready'), 'Unsupported Nest operation')
            paths = [path] + op.get('x-backend-aliases', [])
            for item in paths:
                limit = op['x-route']['max_body_bytes']
                require(item not in limits or limits[item] == limit, 'Conflicting Nest route body limit')
                limits[item] = limit
                routes.setdefault(name, [])
                if item.lstrip('/') not in routes[name]: routes[name].append(item.lstrip('/'))
    return '// Generated from services/{whoami,app-api}/docs/api.yaml; DO NOT EDIT.\n' + 'export const routes = ' + json.dumps(routes, indent=2) + ';\nexport const bodyLimits: Record<string, number> = ' + json.dumps(limits, indent=2) + ';\n'

def main():
    parser = argparse.ArgumentParser();parser.add_argument('service', nargs='?');parser.add_argument('--check', action='store_true');args=parser.parse_args()
    output=ROOT/'services/app-api/src/generated/routes.ts'; content=render()
    if args.check: require(output.exists() and output.read_text()==content,'Stale Nest routes; run make codegen-whoami')
    else: output.parent.mkdir(parents=True, exist_ok=True);output.write_text(content)
if __name__=='__main__':main()
