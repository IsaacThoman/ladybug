# VKE deployment

Run commands from the repo root. The trusted API, queue worker, web UI and egress
gateway run in `ladybug`; one disposable browser pod per scan runs on the tainted
`pool=sandbox` node pool in `sandbox`. The sandbox cannot use DNS or reach the
internet directly. Its only outbound connection is the gateway on TCP 8080.

## Prerequisites

- Terraform >= 1.6, kubectl with kustomize support, Docker/buildx, openssl,
  Python 3, and a Vultr account/API key. Standalone `kustomize` is needed only
  for `build-images.sh --set-images`.
- A Vultr region with VKE, Managed Postgres/Valkey, Object Storage and Registry;
  sufficient quota for the node pools and two Load Balancers.
- A VKE CNI that enforces NetworkPolicy. The deny test below is a deployment gate:
  do not send untrusted URLs until it passes.
- An OpenAI-compatible model endpoint (base URL, model and key) and reputation-service keys, if wanted. Set `API_KEYS` to a
  strong, comma-separated list before exposing the scan submission endpoint.

## Provision and deploy

```sh
export VULTR_API_KEY=... # Keep it out of shell history and committed files.
terraform -chdir=infra/terraform init
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
# Edit terraform.tfvars for the region, registry/bucket names and capacity.
terraform -chdir=infra/terraform apply

export REGISTRY=$(terraform -chdir=infra/terraform output -raw registry)
terraform -chdir=infra/terraform output -raw registry_password |
  docker login "${REGISTRY%%/*}" \
    --username "$(terraform -chdir=infra/terraform output -raw registry_username)" \
    --password-stdin
export TAG=$(git rev-parse --short HEAD)
scripts/build-images.sh --push

cp infra/k8s/secrets.example.env infra/k8s/secrets.env
# Fill in the four local keys in secrets.env. Use literal, unquoted env values.
# The model endpoint's URL and name go in the ConfigMap:
LLM_BASE_URL=https://api.example.com/v1 LLM_MODEL=your-model TAG="$TAG" infra/k8s/bootstrap.sh
export KUBECONFIG="$PWD/infra/k8s/.generated/kubeconfig"
infra/k8s/test/deny-test.sh
kubectl -n ladybug get services
```

The build script builds all five images for `linux/amd64`; without `--push` it
loads them locally. Pass `--set-images` to update the checked-in kustomize image
references, or run its printed commands. Its custom image field also updates
`ladybug-config.data.SANDBOX_IMAGE`, so the dynamically created pods use that tag.
The web build uses same-origin API calls (`VITE_SERVER_URL` is empty).

`bootstrap.sh` uses the Terraform outputs for registry credentials, database URLs,
and object storage. It writes a private kubeconfig and rendered deployment to
`infra/k8s/.generated/`, creates pull Secrets in both namespaces, creates the CA
only if absent, and applies the generated kustomization. That directory and
`secrets.env` are gitignored and excluded from Docker contexts. Terraform state
also contains credentials; store it securely. The bootstrap renders from raw
resources, so its `TAG` wins over any earlier base image edits. Set `S3_REGION`
(default `us-east-1`, accepted by Vultr) and `WORKER_CONCURRENCY` (default 10 per
worker) in the bootstrap environment to override them.

The checked-in base renders with `kubectl kustomize infra/k8s`; its registry and
S3 values are placeholders. Bootstrap supplies real values without changing the
base. After bootstrap, use `kubectl apply -k infra/k8s/.generated` to reapply the
rendered deployment. `kubectl apply -k infra/k8s` is also supported after editing
the base images and ConfigMap and creating the Secrets through bootstrap.
Changes to `envFrom` values need a server/worker rollout; bootstrap restarts them.

The server LoadBalancer exposes port 80 -> 3001 and also port 3001 for the
`server:3001` upstream used by nginx. Web exposes port 80 -> 8080. Configure the
Vultr LB health check to HTTP `/health` for the server, using the annotations
supported by your installed cloud controller. No unverified annotation is set.
The web `/health` proxies to the server; web pod probes use `/` so API outages
do not restart nginx. `/api/` disables proxy buffering/cache and keeps SSE
connections open for an hour.

Workers have no HTTP health endpoint. Their readiness probe checks Valkey PING;
liveness checks that PID 1 exists. These are basic checks, not a queue-consumer
heartbeat. Workers have only sandbox pod lifecycle/log RBAC and retain outbound
access to the Kubernetes API, private databases, S3 and external analysis APIs.
The gateway is the only selected pod in `ladybug` with restricted egress. Its
Deployment bypasses the upstream image's root-only usermod/gosu entrypoint and
runs mitmdump directly as UID 1000 with the mounted CA.

## Verify isolation

The deny test creates a short-lived, non-root curl pod with the same label,
node selector and toleration as a real sandbox. It trusts the public gateway CA,
checks proxied HTTPS succeeds, bypasses DNS for the direct HTTPS deny check,
queries the real cluster DNS resolver and verifies an explicit gateway rejection
of `169.254.169.254`. It prints PASS/FAIL for each check, exits nonzero on failure
and deletes only its own pod. A missing curl image, unready gateway or failed
exec is an error, not evidence that isolation works.

Run it again after CNI/policy changes. If your cluster's DNS Service or CoreDNS
labels differ from `kube-system/kube-dns` and `k8s-app=kube-dns`, adjust the DNS
selector and test together before deployment.

## Capacity and shutdown

Each sandbox requests 1 CPU / 2 GiB and has a 600-second backstop; the worker
normally deletes it immediately after a scan. Two workers at concurrency 10 can
schedule up to 20 pods, so queued/pending work can exceed initial pool capacity.
Prewarm enough nodes for a demo instead of depending on the autoscaler:

```sh
# Set sandbox_min_nodes / sandbox_max_nodes in terraform.tfvars, then:
terraform -chdir=infra/terraform apply
# If changing per-worker concurrency:
WORKER_CONCURRENCY=3 TAG="$TAG" infra/k8s/bootstrap.sh
kubectl -n sandbox get pods -o wide
kubectl -n ladybug scale deployment/worker --replicas=2
```

Bootstrap restores the declared two replicas. Scale workers to zero to stop
new scans, then let existing sandbox pods finish. To shut down between sessions:

```sh
kubectl -n ladybug scale deployment/worker --replicas=0
kubectl -n sandbox get pods
# Back up any reports/artifacts you need. Remove LoadBalancer Services while the
# cluster controller can still deprovision their external load balancers.
kubectl -n ladybug delete service server web --ignore-not-found
# Confirm their Vultr load balancers have disappeared, then remove infrastructure.
terraform -chdir=infra/terraform destroy
```

Destroy removes databases, cluster, registry and artifact storage. Managed DBs
bill even when idle; scaling Deployments down does not turn infrastructure off.
Confirm the bucket can be deleted (archive/empty it if required) and check the
Vultr console for residual billable resources.

## Production hardening

- Chrome currently uses `--no-sandbox` inside the unprivileged container. Add a
  gVisor/Kata RuntimeClass and test browser compatibility before production.
- Enforce per-scan egress byte/request/time budgets at the gateway.
- Pin images by digest, scan them, sign them and enforce signature admission.
- Use private Load Balancers, TLS and authenticated access; API keys currently
  protect scan creation, not report reads or artifacts.
- Rotate the gateway CA deliberately: drain scans, replace `gateway-ca`, restart
  both gateway and worker Deployments, and repeat the deny test. A subPath mount
  does not update in running gateway pods. Bootstrap preserves the existing CA.
- Add a worker heartbeat endpoint and graceful-drain behavior for scans longer
  than the current 120-second termination grace period.
