#!/usr/bin/env python3
"""Migrate legacy history entirely on the primary server, never export chat contents."""

import base64
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from infra.operations.remote import run


def main():
    exporter = (Path(__file__).parent / "export-redis.py").read_text()
    primary = None
    for site in ("yc", "home"):
        if (
            run(
                site,
                "docker exec -u postgres solo-postgres psql -X -At -p 55432 -d postgres -c 'SELECT NOT pg_is_in_recovery()'\n",
                capture=True,
            ).stdout.strip()
            == "t"
        ):
            primary = site
            break
    if primary is None:
        raise RuntimeError("No writable PostgreSQL primary")
    encoded_source = base64.b64encode(exporter.encode()).decode()
    script = '''import base64,json,subprocess
source=base64.b64decode(SOURCE).decode()
snapshot=subprocess.run(['python3','-c',source],text=True,capture_output=True)
if snapshot.returncode:
    print(snapshot.stderr)
    raise SystemExit('Legacy snapshot failed on server')
data=json.loads(snapshot.stdout)
encoded=base64.b64encode(json.dumps(data).encode()).decode()
sql="""BEGIN;
CREATE SEQUENCE IF NOT EXISTS chat.legacy_seq MINVALUE -1000000000 START -1000000000;
WITH imported AS (
 INSERT INTO chat.messages(seq,id,user_id,client_id,text,sent_at)
 SELECT nextval('chat.legacy_seq'),m->>'id',m->>'user_id',coalesce(m->>'client_id',md5('legacy:'||(m->>'id'))),m->>'text',(m->>'sent_at')::bigint
 FROM jsonb_array_elements(convert_from(decode('%s','base64'),'UTF8')::jsonb) m
 ON CONFLICT DO NOTHING RETURNING *
)
INSERT INTO chat.delivery_outbox(task_id,recipient,payload)
 SELECT 'chat_'||md5(i.id||':'||c.user_id),c.user_id,chat.message(i::chat.messages)::text
 FROM imported i CROSS JOIN (SELECT DISTINCT user_id FROM chat.connections WHERE expires>clock_timestamp()) c
 ON CONFLICT DO NOTHING;
COMMIT;
""" % encoded
result=subprocess.run(['docker','exec','-i','-u','postgres','solo-postgres','psql','-X','-v','ON_ERROR_STOP=1','-p','55432','-d','chatdb'],input=sql,text=True,capture_output=True)
if result.returncode:
    raise SystemExit('SQL migration failed; chat contents suppressed')
print('Imported/verified %d legacy messages entirely on server' % len(data))
'''.replace("SOURCE", repr(encoded_source))
    result = run(primary, "python3 - <<'PY'\n" + script + "\nPY\n", capture=True, check=False)
    print(result.stdout)
    if result.returncode:
        print(result.stderr)
        raise SystemExit("Migration failed")


if __name__ == "__main__":
    main()
