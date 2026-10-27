CREATE TABLE IF NOT EXISTS notify_tasks (
 task_id TEXT PRIMARY KEY, recipient TEXT NOT NULL, payload TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','inflight','done')),
 attempt BIGINT NOT NULL, due_ms BIGINT NOT NULL, lease_ms BIGINT NOT NULL,
 needs_publish BOOLEAN NOT NULL, version BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS notify_pending ON notify_tasks(due_ms) WHERE state <> 'done';
