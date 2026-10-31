# Shared world integration (deployment in progress)

The browser uses generated routes from `docs/api.yaml` and the auth service's
OpenAPI contract. Credentials and sessions belong to the existing auth service;
the game does not store passwords or maintain a second account database.

Game connections use WSS at `/api/v1/soloapp_app/v1/signal`. The initial message
carries the session token; Origin is checked and sessions are revalidated.
Coordinates and fish snapshots use WSS. SDP/ICE for peer voice is relayed over
this channel; cross-NAT voice requires an independently configured TURN service.

PostgreSQL stores world checkpoints, a simulator lease, presence, and transient
peer signaling. All accesses use ODB. A locked singleton row serializes admission,
lease changes, and checkpoint commits: a process cannot publish an uncommitted
world snapshot. Database time controls the lease and simulation progression.
A replacement restores the committed checkpoint; clients reconnect after failure.
Catch-up is bounded to one second, so a prolonged outage pauses the world.

YC/home share their database and one world. The isolated Mac deployment has its
own database and world. Offline world merging is not implemented.

The current transaction serializes all portals and uses several database round
trips. WAN throughput and failover still require integration testing; unit tests
alone do not establish the target realtime update rate.

The frontend is a native ES-module bundle. `make package REVISION=<git-sha>`
produces a validated versioned archive for the existing S3 publication protocol.
Production publication must verify both storage copies before activation.
