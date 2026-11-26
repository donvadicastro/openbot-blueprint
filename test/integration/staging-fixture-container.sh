#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
container="openbot-staging-test-$$"
volume="openbot-staging-test-$$"
image="openbot-blueprint-staging-fixture:local"
token='disposable-staging-fixture-token-0123456789'
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker buildx build --load -t "$image" -f "$root/deploy/workflow/staging-fixture.Dockerfile" "$root" >/dev/null
docker volume create "$volume" >/dev/null
start() {
  docker run -d --name "$container" -e "STAGING_TARGET_TOKEN=$token" -e STAGING_DROP_FIRST_RECEIPT=true -v "$volume:/data" "$image" >/dev/null
  attempt=0
  until docker exec "$container" node -e 'fetch("http://127.0.0.1:4520/").then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; do
    attempt=$((attempt + 1)); if [ "$attempt" -ge 30 ]; then docker logs "$container" >&2; exit 1; fi
    sleep 1
  done
}
start
docker exec "$container" node --input-type=module -e '
import { writeFileSync } from "node:fs";
const operation={operationId:"fixture-operation",projectId:"fixture-project",candidateDigest:"a".repeat(40),target:"staging-fixture"};
const call=async(path,body)=>fetch(`http://127.0.0.1:4520/internal/staging/${path}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${process.env.STAGING_TARGET_TOKEN}`},body:JSON.stringify(body)});
try { await call("deploy",operation); throw Error("Expected the first receipt to be lost"); } catch (error) { if (error.message === "Expected the first receipt to be lost") throw error; }
const recovered=await (await call("lookup",operation)).json();
if(recovered.status!=="confirmed" || !recovered.receipt?.receiptId) throw Error("Effect not recovered");
const verified=await (await call("verify",recovered.receipt)).json();
if(verified.status!=="verified" || !verified.verification?.verificationId) throw Error("Verification missing");
writeFileSync("/data/probe-receipt",recovered.receipt.receiptId);
'
docker rm -f "$container" >/dev/null
start
docker exec "$container" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const operation={operationId:"fixture-operation",projectId:"fixture-project",candidateDigest:"a".repeat(40),target:"staging-fixture"};
const response=await fetch("http://127.0.0.1:4520/internal/staging/lookup",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${process.env.STAGING_TARGET_TOKEN}`},body:JSON.stringify(operation)});
const recovered=await response.json();
const database=new DatabaseSync("/data/staging.sqlite");
if(recovered.status!=="confirmed" || recovered.receipt?.receiptId!==readFileSync("/data/probe-receipt","utf8") || database.prepare("select count(*) as count from effects").get().count!==1) throw Error("Effect did not persist exactly once");
database.close();
'
echo 'Disposable staging fixture: lost response, verification, and one effect across container restart passed.'
