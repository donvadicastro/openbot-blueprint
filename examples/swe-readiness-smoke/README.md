# OpenBot SWE workspace readiness smoke project

This small local-only fixture proves project startup and role readiness setup. It contains no credentials, external service dependencies, or production data.

## Roles and startup evidence

The software-development blueprint provisions Team Lead, Product Manager, Engineer, QA, and Release. Each must report its role readiness. Engineer, QA, and Release must also verify access to this source and the project's isolated VM.

The project is intentionally minimal. Its CI definition is in `.github/workflows/ci.yml`; local test instructions are in `docs/test-environment.md`; the product boundary is in `docs/requirements.md`. These references are optional recommended artifacts, while the source folder is the required initialization artifact.

## Local check

Run `node --test` with Node.js 22 or later. No packages need to be installed.
