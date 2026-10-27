#!/usr/bin/env python3
"""Publish one validated OCI archive to the local mTLS registry; never build images."""
import hashlib, http.client, json, os, re, ssl, sys, tarfile, tempfile
from pathlib import Path
from urllib.parse import urlsplit, urlencode

SERVICES=('auth','whoami','web')
MAX_ARCHIVE=2*1024**3
ACCEPT='application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'


def context(directory, identity='push'):
    ctx=ssl.create_default_context(cafile=str(directory/'ca.crt'))
    ctx.load_cert_chain(str(directory/(identity+'.crt')), str(directory/(identity+'.key')))
    return ctx


def request(ctx, host, port, method, path, data=None, headers=None):
    conn=http.client.HTTPSConnection(host,port,context=ctx,timeout=120)
    try:
        conn.request(method,path,body=data,headers=headers or {})
        response=conn.getresponse()
        content=response.read(2*1024**2)
        return response.status,dict((k.lower(),v) for k,v in response.getheaders()),content
    finally: conn.close()


def digest(data): return 'sha256:'+hashlib.sha256(data).hexdigest()


def load_archive(path):
    tar=tarfile.open(path,mode='r:')
    try: return parse_archive(tar)
    except BaseException:
        tar.close()
        raise


def parse_archive(tar):
    members={}
    for entry in tar:
        if entry.isdir(): continue
        if not entry.isfile() or not (entry.name in ('index.json','oci-layout','manifest.json') or re.fullmatch(r'blobs/sha256/[0-9a-f]{64}',entry.name)):
            raise ValueError('Unsafe OCI archive member')
        if entry.name in members: raise ValueError('Duplicate archive member')
        if len(members)>=8192 or entry.size>MAX_ARCHIVE: raise ValueError('Oversized archive')
        members[entry.name]=entry
    def read(name,limit=4*1024**2):
        entry=members[name]
        if entry.size>limit: raise ValueError('Oversized manifest')
        return tar.extractfile(entry).read()
    def blob(desc):
        value=desc['digest']
        if not re.fullmatch(r'sha256:[0-9a-f]{64}',value): raise ValueError('Invalid digest')
        entry=members['blobs/sha256/'+value[7:]]
        if entry.size!=desc['size']: raise ValueError('Descriptor size mismatch')
        return entry
    image=json.loads(read('index.json'))
    for depth in range(4):
        descriptors=[d for d in image['manifests'] if d.get('platform',{}).get('os','linux')=='linux' and d.get('platform',{}).get('architecture','amd64')=='amd64']
        if len(descriptors)!=1: raise ValueError('Expected one linux/amd64 image')
        manifest=read(blob(descriptors[0]).name)
        if digest(manifest)!=descriptors[0]['digest']: raise ValueError('Corrupt manifest')
        image=json.loads(manifest)
        if 'manifests' not in image: break
    else: raise ValueError('Too many nested indexes')
    for desc in [image['config'],*image['layers']]:
        member=blob(desc)
        with tar.extractfile(member) as stream:
            actual=hashlib.file_digest(stream,'sha256').hexdigest() if hasattr(hashlib,'file_digest') else hash_stream(stream)
        if 'sha256:'+actual!=desc['digest']: raise ValueError('Corrupt image blob')
    config=json.loads(read(blob(image['config']).name))
    if (config.get('os'),config.get('architecture'))!=('linux','amd64'):
        raise ValueError('Expected linux/amd64 runtime')
    return tar,members,image,manifest,config


def hash_stream(stream):
    h=hashlib.sha256()
    while True:
        data=stream.read(1024**2)
        if not data:return h.hexdigest()
        h.update(data)


def version_alias(ctx, base, config, manifest, media):
    version=config.get('config',{}).get('Labels',{}).get('org.opencontainers.image.version','')
    if not re.fullmatch(r'v0\.1\.(0|[1-9][0-9]*)',version):return
    path=base+'/manifests/'+version
    status,_,body=request(ctx,'127.0.0.1',5044,'GET',path,headers={'Accept':ACCEPT})
    if status==200:
        if digest(body)!=digest(manifest):raise ValueError('Version alias already has another digest')
        return
    if status!=404:raise RuntimeError('Version lookup failed: '+str(status))
    status,_,_=request(ctx,'127.0.0.1',5044,'PUT',path,data=manifest,headers={'Content-Type':media})
    if status!=201:raise RuntimeError('Version alias publication failed: '+str(status))


def publish(path,service,revision,directory):
    tar,members,image,manifest,config=load_archive(path)
    if config.get('config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=revision:
        raise ValueError('OCI revision label must match approved commit')
    ctx=context(directory)
    base='/v2/soloapp/'+service
    tag='git-'+revision
    expected=digest(manifest)
    status,headers,body=request(ctx,'127.0.0.1',5044,'GET',base+'/manifests/'+tag,headers={'Accept':ACCEPT})
    if status==200:
        if digest(body)!=expected:raise ValueError('Immutable release tag already has another digest')
        version_alias(ctx,base,config,manifest,image.get('mediaType','application/vnd.oci.image.manifest.v1+json'))
        tar.close()
        return expected
    if status!=404: raise RuntimeError('Registry unavailable: '+str(status))
    for desc in [image['config'],*image['layers']]:
        status,_,_=request(ctx,'127.0.0.1',5044,'HEAD',base+'/blobs/'+desc['digest'])
        if status==200:continue
        if status!=404:raise RuntimeError('Blob lookup failed: '+str(status))
        status,headers,_=request(ctx,'127.0.0.1',5044,'POST',base+'/blobs/uploads/',data=b'')
        if status!=202:raise RuntimeError('Upload start failed: '+str(status))
        location=urlsplit(headers['location'])
        if location.netloc or not location.path.startswith(base+'/blobs/uploads/'):
            raise ValueError('Unexpected registry upload location')
        path=location.path+'?'+location.query+('&' if location.query else '')+urlencode({'digest':desc['digest']})
        with tar.extractfile(members['blobs/sha256/'+desc['digest'][7:]]) as stream:
            status,_,_=request(ctx,'127.0.0.1',5044,'PUT',path,data=stream,headers={'Content-Type':'application/octet-stream','Content-Length':str(desc['size'])})
        if status!=201:raise RuntimeError('Blob upload failed: '+str(status))
    status,_,_=request(ctx,'127.0.0.1',5044,'PUT',base+'/manifests/'+tag,data=manifest,headers={'Content-Type':image.get('mediaType','application/vnd.oci.image.manifest.v1+json')})
    if status!=201:raise RuntimeError('Manifest upload failed: '+str(status))
    status,_,body=request(ctx,'127.0.0.1',5044,'GET',base+'/manifests/'+tag,headers={'Accept':ACCEPT})
    if status!=200 or digest(body)!=expected: raise RuntimeError('Registry read-back mismatch')
    version_alias(ctx,base,config,manifest,image.get('mediaType','application/vnd.oci.image.manifest.v1+json'))
    tar.close()
    return expected


def main():
    revision,service=sys.argv[1:3]
    if not re.fullmatch(r'[0-9a-f]{40}',revision) or service not in SERVICES:raise SystemExit('Invalid release/service')
    directory=Path(os.environ.get('REGISTRY_SECRETS','/run/soloapp-registry'))
    with tempfile.TemporaryDirectory(prefix='registry-push-') as tmp:
        archive=Path(tmp)/'image.oci.tar'
        size=0
        with archive.open('wb') as output:
            while True:
                data=sys.stdin.buffer.read(1024**2)
                if not data:break
                size+=len(data)
                if size>MAX_ARCHIVE:raise ValueError('OCI archive exceeds 2 GiB')
                output.write(data)
        print(json.dumps({'service':service,'revision':revision,'digest':publish(archive,service,revision,directory)}))

if __name__=='__main__':main()
