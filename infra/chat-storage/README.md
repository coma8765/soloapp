# Durable chat storage

PostgreSQL owns chat history, delivery intent, connection presence and delivery receipts.
`schema.sql` defines the tables and scoped functions; `grants.sql` restricts the application roles.

Outbox publishers pause claiming for 20 seconds after a publication/confirmation
failure, longer than the 15-second row lease. This lets healthy site publishers
recover the batch rather than the failing site repeatedly reclaiming it. Successful
rows in a partially failed batch remain confirmed. Delivery is still at least once;
stable task IDs protect the publish-success/confirmation-failure window.
