#!/usr/bin/env python3
"""Allocate a durable v0.1.P tag per source revision, or resolve a rollback tag."""
import json, os, re, subprocess, sys
VERSION = re.compile(r'v0\.1\.(0|[1-9][0-9]*)')
SHA = re.compile(r'[0-9a-f]{40}')

def select_version(tags, sha):
    releases=[tag for tag in tags if VERSION.fullmatch(tag['name'])]
    existing=[tag['name'] for tag in releases if tag['commit']['sha']==sha]
    if existing:return max(existing,key=lambda value:int(value.rsplit('.',1)[1])),False
    patch=max((int(tag['name'].rsplit('.',1)[1]) for tag in releases),default=-1)+1
    return 'v0.1.'+str(patch),True

def resolve(tags,value):
    if SHA.fullmatch(value):return value
    if not VERSION.fullmatch(value):raise ValueError('Expected v0.1.P or a full commit SHA')
    matches=[tag['commit']['sha'] for tag in tags if tag['name']==value]
    if len(matches)!=1:raise ValueError('Unknown release version')
    return matches[0]

def gh(*args):
    return json.loads(subprocess.check_output(['gh','api',*args],text=True))

def main():
    mode,value=sys.argv[1:3]
    repo=os.environ['GITHUB_REPOSITORY']
    pages=gh('--paginate','--slurp','repos/'+repo+'/tags?per_page=100')
    tags=[tag for page in pages for tag in page]
    if mode=='reserve':
        if not SHA.fullmatch(value):raise ValueError('Invalid revision')
        version,create=select_version(tags,value)
        if create:gh('repos/'+repo+'/git/refs','-f','ref=refs/tags/'+version,'-f','sha='+value)
        result={'version':version,'target':value,'operation':'deploy'}
    elif mode=='resolve':
        target=resolve(tags,value)
        version=next((tag['name'] for tag in tags if VERSION.fullmatch(tag['name']) and tag['commit']['sha']==target),target)
        result={'version':version,'target':target,'operation':'rollback'}
    else:raise ValueError('Invalid operation')
    with open(os.environ['GITHUB_OUTPUT'],'a') as output:
        for key,val in result.items():output.write(key+'='+val+'\n')
    print(json.dumps(result))

if __name__=='__main__':main()
