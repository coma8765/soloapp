REVOKE ALL ON DATABASE chatdb FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$
DECLARE site text; role_name text; function_name text;
BEGIN
 FOREACH site IN ARRAY ARRAY['yc','home'] LOOP
  FOREACH role_name IN ARRAY ARRAY['chat_api_'||site,'gateway_'||site,'notify_'||site] LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('CREATE ROLE %I LOGIN',role_name);
   END IF;
   EXECUTE format('GRANT CONNECT ON DATABASE chatdb TO %I',role_name);
   EXECUTE format('ALTER ROLE %I CONNECTION LIMIT 24',role_name);
   EXECUTE format('ALTER ROLE %I SET statement_timeout=4000',role_name);
  END LOOP;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I','notify_'||site);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.notify_tasks TO %I','notify_'||site);
  EXECUTE format('GRANT USAGE ON SCHEMA chat TO %I, %I','chat_api_'||site,'gateway_'||site);
  FOREACH function_name IN ARRAY ARRAY['history()','send(text,text,text)','issue_ticket(text,text)','claim_outbox()','confirm_outbox(text)'] LOOP
   EXECUTE format('GRANT EXECUTE ON FUNCTION chat.%s TO %I',function_name,'chat_api_'||site);
  END LOOP;
  FOREACH function_name IN ARRAY ARRAY['history()','consume_ticket(text)','connection_open(text,text)','connection_refresh(text)','connection_close(text)','delivery_begin(text,bigint,bigint,text,text)','delivery_read(text)','delivery_state(text)','delivery_ack(text,bigint,text)','delivery_cancel(text,bigint)'] LOOP
   EXECUTE format('GRANT EXECUTE ON FUNCTION chat.%s TO %I',function_name,'gateway_'||site);
  END LOOP;
 END LOOP;
END $$;
