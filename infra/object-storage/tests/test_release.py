import hashlib,io,json,sys,tarfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path[:0]=[str(ROOT/'libs'),str(ROOT/'infra/object-storage')]
from storage.release import unpack,safe_path
from publish import publish,verify_copies
from botocore.exceptions import ClientError
SHA='a'*40

class Store:
 def __init__(self,fail=False):self.data={};self.fail=fail
 def head_bucket(self,**kw):
  if self.fail:raise OSError('offline')
 def put_object(self,Key,Body,**kw):self.data[Key]=Body
 def get_object(self,Key,**kw):
  if self.fail:raise OSError('offline')
  if Key not in self.data:raise ClientError({'ResponseMetadata':{'HTTPStatusCode':404}},'GetObject')
  return {'Body':io.BytesIO(self.data[Key])}

class ReleaseTests(unittest.TestCase):
 def test_paths_and_links(self):
  for path in ('../secret','/etc/passwd','a/../b','a\\b','a//b'):
   with self.assertRaises(ValueError):safe_path(path)
  buf=io.BytesIO()
  with tarfile.open(fileobj=buf,mode='w:gz') as tf:
   info=tarfile.TarInfo('link');info.type=tarfile.SYMTYPE;info.linkname='/etc/passwd';tf.addfile(info)
  with self.assertRaises(ValueError):unpack(buf.getvalue(),SHA)
 def test_never_publish_with_one_replica(self):
  stores=[Store(),Store(fail=True)]
  with self.assertRaises(OSError):publish('web',stores,SHA,{'index.html':b'html'},b'{}')
  self.assertEqual(stores[0].data,{})
 def test_commit_only_after_readback_and_matching_content(self):
  stores=[Store(),Store()];data={'index.html':b'html'}
  manifest=json.dumps({'revision':SHA,'files':{'index.html':hashlib.sha256(b'html').hexdigest()}}).encode()
  publish('web',stores,SHA,data,manifest)
  self.assertEqual(verify_copies('web',stores,SHA),manifest)
  stores[1].data[f'releases/{SHA}/committed.json']=b'{}'
  with self.assertRaises(ValueError):verify_copies('web',stores,SHA)
 def test_readback_corruption_prevents_commit(self):
  class Corrupt(Store):
   def get_object(self,Key,**kw):
    result=super().get_object(Key=Key,**kw)
    if Key.endswith('/index.html'):result['Body']=io.BytesIO(b'corrupt')
    return result
  stores=[Store(),Corrupt()]
  with self.assertRaises(ValueError):publish('web',stores,SHA,{'index.html':b'html'},b'{}')
  for store in stores:self.assertNotIn(f'releases/{SHA}/committed.json',store.data)
 def test_existing_revision_cannot_change(self):
  stores=[Store(),Store()];stores[1].data[f'releases/{SHA}/manifest.json']=b'previous'
  with self.assertRaises(ValueError):publish('web',stores,SHA,{},b'other')
  self.assertEqual(stores[0].data,{})

if __name__=='__main__':unittest.main()
