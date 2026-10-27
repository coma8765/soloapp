-- Apply as migration owner in chatdb, after client-notify/deploy/schema.sql.
BEGIN;
CREATE SCHEMA IF NOT EXISTS chat;
REVOKE ALL ON SCHEMA chat FROM PUBLIC;
CREATE SEQUENCE IF NOT EXISTS chat.message_seq START WITH 2000000000000;
CREATE TABLE IF NOT EXISTS chat.messages (
 seq bigint PRIMARY KEY DEFAULT nextval('chat.message_seq'),
 id text UNIQUE NOT NULL, user_id text NOT NULL, client_id text NOT NULL,
 text text NOT NULL CHECK(length(text) BETWEEN 1 AND 1000), sent_at bigint NOT NULL,
 UNIQUE(user_id,client_id)
);
CREATE TABLE IF NOT EXISTS chat.quota (user_id text, kind text, started timestamptz NOT NULL, count integer NOT NULL, PRIMARY KEY(user_id,kind));
CREATE TABLE IF NOT EXISTS chat.tickets (hash text PRIMARY KEY, user_id text NOT NULL, expires timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS chat_ticket_expiry ON chat.tickets(expires);
CREATE TABLE IF NOT EXISTS chat.connections (id text PRIMARY KEY, user_id text NOT NULL, expires timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS chat_connection_expiry ON chat.connections(expires);
CREATE TABLE IF NOT EXISTS chat.delivery_outbox (
 task_id text PRIMARY KEY, recipient text NOT NULL, payload text NOT NULL,
 published boolean NOT NULL DEFAULT false, lease timestamptz NOT NULL DEFAULT '-infinity'
);
CREATE INDEX IF NOT EXISTS chat_delivery_pending ON chat.delivery_outbox(lease) WHERE NOT published;
CREATE TABLE IF NOT EXISTS chat.receipts (
 task_id text PRIMARY KEY REFERENCES public.notify_tasks(task_id), recipient text NOT NULL,
 payload text NOT NULL, attempt bigint NOT NULL, deadline_ms bigint NOT NULL,
 cancelled boolean NOT NULL DEFAULT false, done boolean NOT NULL DEFAULT false
);
CREATE OR REPLACE FUNCTION chat.allowed(u text,k text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
DECLARE n integer;
BEGIN
 INSERT INTO chat.quota VALUES(u,k,clock_timestamp(),1)
 ON CONFLICT(user_id,kind) DO UPDATE SET
 count=CASE WHEN chat.quota.started < clock_timestamp()-interval '10 seconds' THEN 1 ELSE chat.quota.count+1 END,
 started=CASE WHEN chat.quota.started < clock_timestamp()-interval '10 seconds' THEN clock_timestamp() ELSE chat.quota.started END
 RETURNING count INTO n;
 RETURN n<=10;
END $$;
CREATE OR REPLACE FUNCTION chat.message(m chat.messages) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,chat AS $$
 SELECT jsonb_build_object('id',m.id,'user_id',m.user_id,'text',m.text,'sent_at',m.sent_at)
$$;
CREATE OR REPLACE FUNCTION chat.history() RETURNS TABLE(message jsonb) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
 SELECT chat.message(m) FROM (SELECT * FROM chat.messages ORDER BY seq DESC LIMIT 100) m ORDER BY seq
$$;
CREATE OR REPLACE FUNCTION chat.send(u text,c text,t text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
DECLARE m chat.messages; s bigint;
BEGIN
 IF u !~ '^[0-9a-f]{32}$' OR c !~ '^[0-9a-f]{32}$' OR length(t) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'invalid message'; END IF;
 PERFORM pg_advisory_xact_lock(72626002);
 SELECT * INTO m FROM chat.messages WHERE user_id=u AND client_id=c;
 IF FOUND THEN RETURN chat.message(m); END IF;
 IF NOT chat.allowed(u,'send') THEN RETURN NULL; END IF;
 s:=nextval('chat.message_seq');
 INSERT INTO chat.messages(seq,id,user_id,client_id,text,sent_at)
 VALUES(s,s::text||'-0',u,c,t,(extract(epoch FROM clock_timestamp())*1000)::bigint) RETURNING * INTO m;
 -- One durable delivery per account online at commit time. Offline accounts recover history.
 INSERT INTO chat.delivery_outbox(task_id,recipient,payload)
 SELECT 'chat_'||md5(m.id||':'||user_id),user_id,chat.message(m)::text
 FROM (SELECT DISTINCT user_id FROM chat.connections WHERE expires>clock_timestamp()) online;
 RETURN chat.message(m);
END $$;
CREATE OR REPLACE FUNCTION chat.issue_ticket(u text,h text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
BEGIN
 IF u !~ '^[0-9a-f]{32}$' OR h !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid ticket'; END IF;
 IF NOT chat.allowed(u,'ticket') THEN RETURN false; END IF;
 DELETE FROM chat.tickets WHERE expires < clock_timestamp();
 INSERT INTO chat.tickets VALUES(h,u,clock_timestamp()+interval '30 seconds');
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION chat.consume_ticket(h text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
 DELETE FROM chat.tickets WHERE hash=h AND expires > clock_timestamp() RETURNING user_id
$$;
CREATE OR REPLACE FUNCTION chat.connection_open(i text,u text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
BEGIN
 IF i !~ '^[0-9a-f]{32}$' OR u !~ '^[0-9a-f]{32}$' THEN RAISE EXCEPTION 'invalid connection'; END IF;
 DELETE FROM chat.connections WHERE expires < clock_timestamp();
 INSERT INTO chat.connections VALUES(i,u,clock_timestamp()+interval '45 seconds');
END $$;
CREATE OR REPLACE FUNCTION chat.connection_refresh(i text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
 UPDATE chat.connections SET expires=clock_timestamp()+interval '45 seconds' WHERE id=i
$$;
CREATE OR REPLACE FUNCTION chat.connection_close(i text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
 DELETE FROM chat.connections WHERE id=i
$$;
CREATE OR REPLACE FUNCTION chat.claim_outbox() RETURNS TABLE(task_id text,recipient text,payload text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
 UPDATE chat.delivery_outbox SET lease=clock_timestamp()+interval '15 seconds'
 WHERE chat.delivery_outbox.task_id IN (
 SELECT o.task_id FROM chat.delivery_outbox o WHERE NOT published AND lease<clock_timestamp()
 ORDER BY lease LIMIT 8 FOR UPDATE SKIP LOCKED)
 RETURNING chat.delivery_outbox.task_id,chat.delivery_outbox.recipient,chat.delivery_outbox.payload
$$;
CREATE OR REPLACE FUNCTION chat.confirm_outbox(i text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
 UPDATE chat.delivery_outbox SET published=true WHERE task_id=i
$$;
CREATE OR REPLACE FUNCTION chat.delivery_begin(i text,a bigint,d bigint,u text,p text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
DECLARE job public.notify_tasks; receipt chat.receipts; now_ms bigint;
BEGIN
 now_ms:=(extract(epoch FROM clock_timestamp())*1000)::bigint;
 SELECT * INTO job FROM public.notify_tasks WHERE task_id=i FOR UPDATE;
 IF NOT FOUND OR job.recipient<>u OR job.payload<>p THEN RETURN 'invalid'; END IF;
 SELECT * INTO receipt FROM chat.receipts WHERE task_id=i;
 IF FOUND AND receipt.done THEN RETURN 'done'; END IF;
 IF job.state<>'inflight' OR job.attempt<>a OR job.lease_ms<=now_ms OR d<=now_ms OR d>now_ms+300000 THEN RETURN 'stale'; END IF;
 IF receipt.attempt>a OR (receipt.attempt=a AND receipt.cancelled) THEN RETURN 'stale'; END IF;
 INSERT INTO chat.receipts VALUES(i,u,p,a,least(d,job.lease_ms),false,false)
 ON CONFLICT(task_id) DO UPDATE SET attempt=a,deadline_ms=least(d,job.lease_ms),cancelled=false;
 -- Only wakeup IDs are broadcast. Durable tasks/receipts are the source of truth.
 PERFORM pg_notify('soloapp_delivery',i);
 RETURN 'pending';
END $$;
CREATE OR REPLACE FUNCTION chat.delivery_read(i text) RETURNS TABLE(task_id text,recipient text,payload text,attempt bigint,deadline_ms bigint) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
 SELECT r.task_id,r.recipient,r.payload,r.attempt,r.deadline_ms FROM chat.receipts r JOIN public.notify_tasks t USING(task_id)
 WHERE r.task_id=i AND NOT r.cancelled AND NOT r.done AND r.attempt=t.attempt AND t.state='inflight'
 AND least(r.deadline_ms,t.lease_ms)>(extract(epoch FROM clock_timestamp())*1000)::bigint
$$;
CREATE OR REPLACE FUNCTION chat.delivery_state(i text) RETURNS TABLE(done boolean,cancelled boolean,attempt bigint) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
 SELECT done,cancelled,attempt FROM chat.receipts WHERE task_id=i
$$;
CREATE OR REPLACE FUNCTION chat.delivery_ack(i text,a bigint,u text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
DECLARE changed integer;
BEGIN
 PERFORM 1 FROM public.notify_tasks WHERE task_id=i FOR UPDATE;
 UPDATE chat.receipts r SET done=true FROM public.notify_tasks t
 WHERE r.task_id=i AND t.task_id=i AND r.recipient=u AND r.attempt=a AND t.attempt=a
 AND t.state='inflight' AND NOT r.cancelled AND least(r.deadline_ms,t.lease_ms)>(extract(epoch FROM clock_timestamp())*1000)::bigint;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed>0 THEN PERFORM pg_notify('soloapp_receipt',i); END IF;
 RETURN changed>0;
END $$;
CREATE OR REPLACE FUNCTION chat.delivery_cancel(i text,a bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,chat AS $$
BEGIN
 PERFORM 1 FROM public.notify_tasks WHERE task_id=i FOR UPDATE;
 INSERT INTO chat.receipts(task_id,recipient,payload,attempt,deadline_ms,cancelled,done)
 SELECT task_id,recipient,payload,attempt,lease_ms,true,false FROM public.notify_tasks
 WHERE task_id=i AND attempt=a AND state<>'done'
 ON CONFLICT(task_id) DO UPDATE SET attempt=EXCLUDED.attempt,deadline_ms=EXCLUDED.deadline_ms,cancelled=true
 WHERE NOT chat.receipts.done AND chat.receipts.attempt<=EXCLUDED.attempt;
 PERFORM pg_notify('soloapp_receipt',i);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA chat FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA chat FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA chat FROM PUBLIC;
COMMIT;
