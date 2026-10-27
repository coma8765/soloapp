import hashlib
import hmac

CREDENTIALS={'username':'Alice.Test','password':'valid-password-123'}

async def test_odb_auth_lifecycle(service_client,pgsql):
    registered=await service_client.post('/api/v1/auth/v1/register',json=CREDENTIALS)
    assert registered.status_code==201
    user_id=registered.json()['user_id']
    duplicate=await service_client.post('/api/v1/auth/v1/register',json={**CREDENTIALS,'username':'alice.test'})
    assert duplicate.status_code==409
    login=await service_client.post('/api/v1/auth/v1/login',json={**CREDENTIALS,'username':'ALICE.TEST'})
    assert login.status_code==200
    data=login.json();token=data['access_token'];assert data['user_id']==user_id
    with pgsql['authdb'].cursor() as cur:
        cur.execute('SELECT username,password_hash FROM users')
        username,password_hash=cur.fetchone()
        assert username=='alice.test' and password_hash.startswith('$argon2id$')
        cur.execute('SELECT token_hash,expires_at>now(),expires_at<now()+interval \'25 hours\' FROM sessions')
        assert cur.fetchone()==(hashlib.sha256(token.encode()).hexdigest(),True,True)
    headers={'Authorization':'Bearer '+token}
    assert (await service_client.get('/api/v1/auth/v1/me',headers=headers)).json()=={'user_id':user_id}
    verified=await service_client.get('/api/v1/auth/v1/internal/verify',headers=headers)
    stamp=verified.headers['X-User-Timestamp']
    expected=hmac.new(bytes.fromhex('01'*32),f'soloapp-user-id:{user_id}:{stamp}'.encode(),hashlib.sha256).hexdigest()
    assert verified.headers['X-User-Signature']==expected
    assert (await service_client.post('/api/v1/auth/v1/logout',headers=headers)).status_code==204
    assert (await service_client.get('/api/v1/auth/v1/me',headers=headers)).status_code==401
    assert (await service_client.post('/api/v1/auth/v1/logout',headers=headers)).status_code==204

async def test_expired_session_and_timezone(service_client,pgsql):
    await service_client.post('/api/v1/auth/v1/register',json=CREDENTIALS)
    login=await service_client.post('/api/v1/auth/v1/login',json=CREDENTIALS)
    token=login.json()['access_token']
    with pgsql['authdb'].cursor() as cur:
        cur.execute("SET TIME ZONE 'Asia/Tokyo'")
        cur.execute("UPDATE sessions SET expires_at=now()-interval '1 second'")
    assert (await service_client.get('/api/v1/auth/v1/me',headers={'Authorization':'Bearer '+token})).status_code==401

async def test_wrong_credentials_and_malformed_requests(service_client):
    assert (await service_client.post('/api/v1/auth/v1/login',json=CREDENTIALS)).status_code==401
    assert (await service_client.post('/api/v1/auth/v1/register',json={'username':'valid'})).status_code==400
    assert (await service_client.post('/api/v1/auth/v1/register',json={'username':"a'; DROP TABLE users;--",'password':'valid-password-123'})).status_code==400
    assert (await service_client.get('/ready')).status_code==200
    assert (await service_client.get('/api/v1/auth/v1/me')).status_code==401
    assert (await service_client.get('/api/v1/auth/v1/register')).status_code in (404,405)
