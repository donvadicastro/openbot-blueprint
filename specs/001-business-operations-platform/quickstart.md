# Pilot Validation Guide

Run the baseline checks on the current repository. Run the project and workflow scenarios after the corresponding implementation phases in [the plan](plan.md). Use disposable project source and staging fixtures throughout.

## Prerequisites

- Node.js 22+ and npm for the CLI checks; Python 3 for descriptor-relative host source intake.
- A working Docker engine with Compose, a reachable host running Lima with the platform’s supported hypervisor, and enough disk and memory for two simultaneous project VMs.
- One test owner, a member of only one project, and a designated release approver. Use the authenticated OpenBot configuration for permission tests.
- A local fixture folder with a small application, four deterministic acceptance scenarios, and a disposable staging target that can look up deployment receipts by operation ID.
- Native OpenBot environment settings and a working model endpoint. Verify the pinned Intelligence path against DC-003 before the pilot relies on it. [Environment and local inference setup](../../docs/docker-compose.md)

## Check the baseline and start the app

From the repository root:

```sh
npm ci
npm run check
docker compose version
docker info --format '{{.ServerVersion}}'
limactl --version
```

Prepare local environment files as described in the [Compose guide](../../docs/docker-compose.md), with valid credentials, and place a copy of the source fixture under the configured projects folder. For the blueprint provision command, set the three distinct workflow credentials in that environment file as well. Check the current Compose baseline:

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps -a
docker compose logs blueprint-init
```

The default app address is http://localhost:3010. The baseline proves the current app can start. Run the acceptance scenarios below against the implemented business-platform build and its configured provider. That build’s planned provision command has the following interface:

```sh
npm run blueprint -- provision <blueprint-id> --env-file <path> --app-port <port>
```

Replace the angle-bracket values before running. Provisioning resolves one stable Compose identity per blueprint key in the current deployment environment. Use a separate environment file and port for the distinct blueprint fixture. The command prints the effective Compose project name and app URL for the scenarios below.

For optional live-model component checks, load a chat model in LM Studio and use its exact ID. These checks create disposable database records and simulated service, QA, or staging data; they do not complete the full pilot. The default fixture image can be overridden with `OPENBOT_TEST_IMAGE` after building the pinned server image.

```sh
LIVE_WORKFLOW_MODEL=qwen/qwen3-coder-30b \
LIVE_SKIP_PHASE=1 LIVE_SKIP_LEAD=1 LIVE_SWE_PM=1 \
OPENAI_BASE_URL=http://host.docker.internal:1234/v1 \
bash test/integration/project-initialization.sh
```

Replace `LIVE_SWE_PM=1` with `LIVE_READINESS=1`, `LIVE_SWE_QA=1`, `LIVE_FEEDBACK=1`, `LIVE_TEMP_PLAN=1`, or `LIVE_RELEASE_SUMMARY=1` to run the other isolated model checks. Model output can fail these checks; inspect the tool responses and do not count a rejected or simulated result as an accepted end-to-end run.

For the readiness variant, add `LIVE_REAL_READINESS=1` and set `LIMACTL_PATH` to a working Lima executable to use a new disposable VM and synthetic source instead of the simulated workspace. The native bot resolver and readiness probe run against the local model; turn persistence remains a fixture.

To exercise a disposable restore of the project database, Temporal state, and a real Lima workspace together, build the pinned server image and run:

```sh
OPENBOT_TEST_REAL_VM_RESTORE=1 \
LIMACTL_PATH=/path/to/limactl \
OPENBOT_TEST_IMAGE=openbot-blueprint-server:current-verify \
bash test/integration/workflow-adapter-compose.sh
```

Use an image tag that exists locally and replace the Lima path. The fixture stops its disposable worker, snapshots its databases and a stopped disposable VM and provider receipts, restores them into isolated test instances, and checks that the recovered workflow produces one guest-side effect. It also checks the VM's uncertain operation is held before reconciliation. It does not restore or modify an existing production project.

After building a pinned server image, type-check the server overlay in a disposable container with:

```sh
OPENBOT_TEST_IMAGE=<local-pinned-server-image> sh test/integration/server-typecheck.sh
```

Replace the placeholder with the image tag. This checks the pinned server source and overlay using the compiler configuration included in the image.

## Project setup and isolation

For an existing installation, open **Previous projects** and select a previous
project. Verified private conversations are imported automatically. If a
group contains shared or unverifiable conversations, use **Import project**
and select only the private conversations to attach. Leave other conversations
unselected; they remain accessible from Previous projects. The selection is
remembered on later visits, and selecting no conversations imports just the
project and its source. Retrying the import returns the same project.

1. Open **Projects** and create two SWE projects from the same fixture folder. Submit only the source for the first, and an unusable required input for the second. Expect separate project IDs, distinct VMs and project conversations, and per-bot readiness reports. Confirm the blocked project shows a focused Team Lead question and refuses operational work until corrected. Repeat with missing, stale, and inaccessible prerequisites. Time setup for five pilot owners with the stack and VM image ready. **SC-001, SC-006, SC-009**
2. Edit and build only in the first VM. Verify that the source and second guest are unchanged, and that a member or bot in one project cannot access a known ID from the other without membership. Restart the app and worker and verify the same guest and disk retain the edit and build output. **SC-004, SC-008**
3. Repeat SWE provisioning, including a newer published version of that blueprint, and verify the existing installation is identified. Provision the distinct blueprint on another port, run a supported workflow there, and restart or stop the SWE app while the second app remains reachable with its data intact. Existing projects retain their pinned version. **SC-004**

For the timed setup check, prepare the stack, model endpoint and VM image before each trial. Give each of five owners the same fixture and instructions; start timing when they open Projects and stop when the project is Operational with every specialist ready. Record elapsed time, completion, blockers and any assistance in the pilot record. Do not count automated checks or a simulated user as a participant. Keep source folders and project identities separate for each trial.

For the restart check, replace `<swe-compose-name>` with the name printed at provisioning and run the command with the same environment and Compose files used for that installation:

```sh
docker compose -p <swe-compose-name> --env-file <env-file> -f docker-compose.yml restart server worker workflow-worker
```

Use the same environment file passed to provisioning. For a durability proof, retain the provisioned engine's persistent storage.

## Feature flow, role memory, and live QA

1. Ask for an adoption recommendation and confirm the Team Lead routes discovery to the PM. Ask for a small feature without naming a workflow. Leave a consequential decision open, verify dependent work waits, and answer it later in the same conversation. Verify the PM’s confirmed Change Brief reaches Engineering and QA with exact candidate and record revisions. Use fixtures with a wrong record type, missing field, and invalid reference and confirm each is blocked. **SC-002, SC-007, SC-009, SC-013**
2. Run the four QA scenarios. Use fixture results of three passes and one failure, then three passes and one blocked, then four passes. Expect 75% with rework, 75% with verification waiting, then 100% and a permitted next phase. Verify a duplicate, missing, incorrect aggregate, or stale result cannot advance. Observe updates in the same chat view, disconnect and reconnect, and reopen the final report. Expand a scenario, check permission filtering, and open another role’s view. **SC-010, SC-012**
3. Tell QA to include reproduction steps in reports. Restart the app and verify the next run uses this guidance alongside configured skills and MCP. Correct the guidance and verify the new revision applies to later work. Test two project assignments sharing a bot definition and attempt feedback that asks QA to skip required evidence. **SC-011**
4. Submit a clear fixture request with no published match. Verify the generated workflow cites applicable practices and persists a validated plan. Try a proposal with an unavailable role or missing mandatory approval and verify the affected action is blocked. Restart during a decision wait and resume on the same plan. **SC-013, SC-014**

## Release and recovery

1. Request a staging release. Verify missing runbook, missing target, failed QA, missing approval, and a changed candidate each block deployment. Approve the exact verified candidate and target and confirm the staging receipt and post-deployment evidence. **SC-003**
2. For both a published and temporary workflow, interrupt the active execution worker during a decision wait. Resume the worker, submit the decision once, and inspect phase, wait reason, attempts, and original work history. In a separate run, have the fixture pause after committing the staging effect but before returning its receipt. Interrupt the worker, release the fixture pause, and resume execution. Confirm that the effect is reconciled by operation ID, the target reports exactly one outcome, and OpenBot exposes the history. **SC-005, SC-014**

Record pass/fail and the OpenBot project, work, and run references for each scenario. Retain version information for OpenBot, the VM provider, and the orchestration engine with the pilot results.
