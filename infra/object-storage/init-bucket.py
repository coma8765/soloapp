import json,sys,time
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
cfg=json.load(open('/secrets/admin.json'))
s3=boto3.client('s3',endpoint_url=sys.argv[1],aws_access_key_id=cfg['access_key'],aws_secret_access_key=cfg['secret_key'],region_name='us-east-1',config=Config(signature_version='s3v4',s3={'addressing_style':'path'}))
for attempt in range(20):
 try:
  try: s3.head_bucket(Bucket=cfg['bucket'])
  except ClientError as error:
   if error.response['ResponseMetadata']['HTTPStatusCode']!=404: raise
   s3.create_bucket(Bucket=cfg['bucket'])
  s3.put_bucket_versioning(Bucket=cfg['bucket'],VersioningConfiguration={'Status':'Enabled'})
  assert s3.get_bucket_versioning(Bucket=cfg['bucket'])['Status']=='Enabled'
  print('Private versioned bucket ready');break
 except Exception:
  if attempt==19:raise
  time.sleep(2)
