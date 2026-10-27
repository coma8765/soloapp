#!/usr/bin/env python3
"""Public gateway smoke test; creates one synthetic user, revokes its session."""
import json
import os
import secrets
import urllib.error
import urllib.request

BASE = os.environ.get('SOLOAPP_BASE_URL', '').rstrip('/')


def main():
    if not BASE.startswith('https://'):
        raise SystemExit('Set SOLOAPP_BASE_URL=https://your-deployment before live checks')
    checks = []
    def check(method, path, expected, body=None, headers=None, user_id=None):
        request = urllib.request.Request(BASE + path, method=method, data=body, headers=headers or {})
        try:
            response = urllib.request.urlopen(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.code
            data = response.read()
            site = response.headers.get('X-Solo-Site')
        assert status == expected, (method, path, status, expected)
        if user_id is not None:
            assert json.loads(data)['user_id'] == user_id, 'Spoofed user identity accepted'
        checks.append({'method': method, 'path': path, 'status': status, 'site': site})
        return json.loads(data) if data and data.startswith(b'{') else None

    for path in ('/auth/login', '/auth/register', '/user-id', '/_verify', '/api/v1/auth/v1/internal/verify', '/health/ready', '/api/v1/auth/v1/not-declared'):
        check('GET', path, 404)
    check('GET', '/api/v1/auth/v1/login', 405)
    check('POST', '/api/v1/whoami/v1/user-id', 405)
    check('GET', '/api/v1/app-api/v1/user-id', 401)
    check('POST', '/api/v1/app-api/v1/user-id', 405)
    check('GET', '/api/v1/auth/v1/me', 401)
    check('GET', '/api/v1/whoami/v1/user-id', 401, headers={'X-Verified-User-Id': 'a' * 32, 'X-User-Signature': 'a' * 64, 'X-User-Timestamp': '9999999999'})
    check('POST', '/api/v1/auth/v1/register', 413, b'x' * 8193, {'Content-Type': 'application/json'})
    credentials = json.dumps({'username': 'routes_smoke_' + secrets.token_hex(8), 'password': secrets.token_hex(20)}).encode()
    user_id = check('POST', '/api/v1/auth/v1/register', 201, credentials, {'Content-Type': 'application/json'})['user_id']
    token = check('POST', '/api/v1/auth/v1/login', 200, credentials, {'Content-Type': 'application/json'})['access_token']
    authorization = {'Authorization': 'Bearer ' + token}
    try:
        check('GET', '/api/v1/auth/v1/me', 200, headers=authorization, user_id=user_id)
        check('GET', '/api/v1/app-api/v1/user-id', 200, headers=authorization, user_id=user_id)
        for _ in range(8):
            check('GET', '/api/v1/whoami/v1/user-id', 200, headers={**authorization, 'X-Verified-User-Id': '0' * 32, 'X-User-Signature': '0' * 64, 'X-User-Timestamp': '9999999999'}, user_id=user_id)
    finally:
        check('POST', '/api/v1/auth/v1/logout', 204, headers=authorization)
    check('GET', '/api/v1/whoami/v1/user-id', 401, headers=authorization)
    print(json.dumps({'checks': checks, 'passed': len(checks)}, indent=2))


if __name__ == '__main__':
    main()
