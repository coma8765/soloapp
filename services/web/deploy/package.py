#!/usr/bin/env python3
"""Package and validate the actual Flutter build before publication."""
import argparse,sys,tarfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'libs'))
from storage.release import unpack,revision
p=argparse.ArgumentParser();p.add_argument('revision',type=revision);p.add_argument('output',type=Path);p.add_argument('--directory',type=Path,default=Path('build/web'));args=p.parse_args()
with tarfile.open(args.output,'w:gz') as archive:archive.add(args.directory,arcname='.')
files,_=unpack(args.output.read_bytes(),args.revision)
print({'files':len(files),'bytes':sum(map(len,files.values())),'bundle':str(args.output)})
