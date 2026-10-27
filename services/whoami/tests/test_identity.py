import hashlib
import hmac
import time
import pytest

ID='0123456789abcdef'*2

def signature(user_id,stamp,key='01'*32):
    return hmac.new(bytes.fromhex(key),f'soloapp-user-id:{user_id}:{stamp}'.encode(),hashlib.sha256).hexdigest()

@pytest.mark.parametrize('delta,valid',[(-3,False),(-2,True),(0,True),(10,True),(11,False)])
def test_exact_expiry_boundaries(unit_probe,delta,valid):
    now=1793030000;stamp=str(now-delta)
    assert unit_probe({'user_id':ID,'timestamp':stamp,'signature':signature(ID,stamp),'now':now})['verified'] is valid

@pytest.mark.parametrize('field,value',[('user_id','x'*32),('user_id',ID.upper()),('timestamp','garbage'),('signature','0'*64),('signature','a'*63)])
def test_invalid_identity(unit_probe,field,value):
    stamp='1793030000';body={'user_id':ID,'timestamp':stamp,'signature':signature(ID,stamp),'now':int(stamp)};body[field]=value
    assert not unit_probe(body)['verified']

async def test_signed_request(service_client):
    stamp=str(int(time.time()))
    headers={'X-Verified-User-Id':ID,'X-User-Timestamp':stamp,'X-User-Signature':signature(ID,stamp)}
    response=await service_client.get('/api/v1/whoami/v1/user-id',headers=headers)
    assert response.status_code==200 and response.json()=={'user_id':ID}
    assert response.headers['Cache-Control']=='no-store'
    headers['X-User-Signature']=signature(ID,stamp,'02'*32)
    assert (await service_client.get('/api/v1/whoami/v1/user-id',headers=headers)).status_code==401

async def test_spoof_without_signature(service_client):
    assert (await service_client.get('/api/v1/whoami/v1/user-id',headers={'X-Verified-User-Id':ID})).status_code==401
    assert (await service_client.get('/other')).status_code==404

async def test_http_health_and_client_errors(service_client):
    assert (await service_client.get('/healthz')).status_code == 200
    for _ in range(5):
        assert (await service_client.get('/api/v1/whoami/v1/user-id')).status_code == 401
    assert (await service_client.get('/health/ready')).status_code == 200
