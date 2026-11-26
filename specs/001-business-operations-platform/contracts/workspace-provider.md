# Workspace Provider Contract

The authenticated OpenBot product module invokes a private host adapter. The adapter has no public endpoint and exposes only typed workspace operations. A stable installation and project key maps to one provider VM and persistent disk. Request credentials and host tooling stay outside the guest and bot context.

| Operation | Inputs and results |
| --- | --- |
| Ensure workspace | Installation and project IDs, expected image digest, resource profile and stable request key. Return existing or created provider ID, state, and blocker if any. Reconcile before retrying uncertain creation. |
| Import baseline | Bound provider ID and a server-authorized folder reference. Revalidate the root and import a verified committed Git bundle or bounded folder snapshot into guest storage. Return the source digest and guest revision. |
| Check workspace | Bound provider ID. Return VM and disk identity, reachability and source baseline status. |
| Run approved action | Project and provider ID, authorized action reference, operation key and guest-local inputs. Return execution state and artifact or log references. Operations and artifacts remain within the project boundary. |
| Reconcile action | Project, provider ID and operation key. Return a known prior outcome or Uncertain. |

The project module authorizes the actor and action. The adapter verifies the caller and binding independently. Pass identifiers and structured parameters rather than host shell text. Guest commands run under a project account in the VM. The source folder is read-only during intake. Host directories and administrative sockets stay outside guests. Apply guest network rules that limit access to approved dependencies and prevent access to the host control plane or sibling guests.

Provider outages mark readiness or VM-dependent work as blocked. App restarts reconnect using the stored binding. Independent guests and their disks survive the app lifecycle. Preserve VM and work history on archive under the deployment’s retention policy.

The current Lima implementation uses an unprivileged `openbot-project` guest account and a private Linux network namespace with loopback only. It verifies the namespace and lack of guest-user privilege before executing an action; a missing or modified policy blocks readiness and execution. Direct outbound access is denied by default. Configurable approved egress and the Linux-host acceptance check remain open.
