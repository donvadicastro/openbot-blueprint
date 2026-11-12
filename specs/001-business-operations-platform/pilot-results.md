# Pilot verification record

The pilot is **not complete**. The checks below establish individual components; they do not establish that an OpenBot project can run a complete business workflow or release.

| Check | Result | Scope and limitation |
| --- | --- | --- |
| `npm run check` | Passed: 83 tests | Blueprint validation and component tests, including the staging adapter contract, action-result checks, and QA evidence validation. |
| `sh test/integration/project-initialization.sh` | Passed against disposable PostgreSQL | Project setup, workflow dispatch intent, archive and feedback API/storage checks, including a simulated native transcript and a group message. This does not run a complete bot workflow or a live Intelligence transcript. |
| `npm test` in `deploy/workflow` | Passed: 3 tests | Real local Temporal test server; persisted decision and uncertain-effect recovery. |
| `sh test/integration/temporal-compose.sh` | Passed | Disposable Temporal/PostgreSQL containers and worker were restarted; a pending decision resumed and one fixture effect was reconciled after a lost response. OpenBot activities were replaced with a fixture. |
| `node --test test/integration/staging-target.test.js` | Passed | A disposable staging fixture persisted one simulated effect across a restart after its response was lost. This is not an approved release or a real deployment. |
| `docker compose build server` | Passed | Pinned OpenBot app and server build with the product UI and API changes. |

Open work includes governed bot callbacks and tool access, connecting and scheduling the workflow worker, typed handoffs and QA, release approval and verification, complete project initialization acceptance, backup restoration, and cross-installation acceptance. Workspace outbound access remains default-deny pending explicitly authorized dependency egress and validation on supported hosts. The Temporal overlay remains experimental and is not part of the default stack.
