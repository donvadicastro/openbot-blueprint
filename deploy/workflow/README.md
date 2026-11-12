# Business workflow engine

This is the in-progress Temporal execution path selected in the business-platform plan. It pins Temporal Server `1.29.7` and TypeScript SDK `1.25.0`, and uses a private PostgreSQL database. The overlay has no published database, Temporal, or worker ports. Its PostgreSQL volume is separate from the OpenBot database.

The worker preserves decision waits in Temporal history. Phase activities use one attempt: an unconfirmed result pauses the run until an authorized caller requests reconciliation, which must establish whether the effect occurred before another attempt. The private gateway binds each workflow ID to its installation, project, run, and pinned plan. The product module writes the initial dispatch intent in the same database transaction as the plan.

This is not yet a complete operational workflow. OpenBot's authenticated activity adapter and the outbox scheduler are not connected, so the overlay is not included in the default stack. The worker fails closed when the activity endpoint does not confirm a result. Do not use it to run business work until those integration tasks and the acceptance scenarios are complete.

The overlay requires `WORKFLOW_POSTGRES_PASSWORD`, `WORKFLOW_ACTIVITY_TOKEN`, and `WORKFLOW_ENGINE_TOKEN`; use distinct random values and store them in the native environment file. The activity and gateway tokens must each contain at least 32 characters. It can be inspected without starting services:

```sh
docker compose -f docker-compose.yml -f deploy/workflow/compose.yml config --quiet
```

From this directory, `npm ci && npm test` runs an isolated Temporal test server. The recovery test stops the worker while a decision and an uncertain effect are pending, sends messages while it is down, and verifies that the replacement worker resumes without repeating the effect. These tests use a fixture activity, not a real OpenBot bot or staging target.

From the repository root, `sh test/integration/temporal-compose.sh` exercises a disposable Compose installation with real Temporal and PostgreSQL containers. It restarts Temporal and the worker, then checks that a waiting decision resumes and an effect committed before a lost response is reconciled exactly once. The script removes only the uniquely named containers and volumes it creates.

Temporal references: [TypeScript SDK](https://docs.temporal.io/develop/typescript), [PostgreSQL deployment example](https://github.com/temporalio/samples-server/blob/main/compose/docker-compose-postgres.yml), and [workflow message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing).
