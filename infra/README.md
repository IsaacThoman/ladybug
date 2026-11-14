# VKE deployment

There are two ways to use the cluster: run everything on it (below), or run
[only the sandboxes](#sandboxes-only) on it and keep the rest elsewhere.

Run commands from the repo root. The trusted API, queue worker, web UI and egress
gateway run in `ladybug`; one disposable browser pod per scan runs on the tainted
`pool=sandbox` node pool in `sandbox`. The sandbox cannot use DNS or reach the
internet directly. Its only outbound connection is the gateway on TCP 8080.

## Prerequisites

- Terraform >= 1.6, kubectl with kustomize support, Docker/buildx, openssl,
  Python 3, and a Vultr account/API key. Standalone `kustomize` is needed only
  for `build-images.sh --set-images`.
- A Vultr region with VKE, Managed Postgres/Valkey and Object Storage;
  sufficient quota for the node pools and one Load Balancer. The Container
  Registry is in fewer regions: set `registry_region` if yours lacks it.
- A VKE CNI that enforces NetworkPolicy. The deny test below is a deployment gate:
  do not send untrusted URLs until it passes.
- An OpenAI-compatible model endpoint (base URL, model and key) and reputation-service keys, if wanted. Scans need an approved
  account; `API_KEYS` is only for scripts that start scans without one.

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
# SITE_DOMAIN defaults to ladybugg.garden.
LLM_BASE_URL=https://api.example.com/v1 LLM_MODEL=your-model TAG="$TAG" infra/k8s/bootstrap.sh
export KUBECONFIG="$PWD/infra/k8s/.generated/kubeconfig"
infra/k8s/test/deny-test.sh
kubectl -n ladybug get service edge   # point the domain's A record at EXTERNAL-IP
```

### Public domain

Everything public is served from one origin, `https://ladybugg.garden` by
default (`SITE_DOMAIN` in the bootstrap environment). That's the URL packaged
desktop apps and release builds of the extension use by default.

- The `edge` Deployment runs Caddy behind the cluster's only Load Balancer
  (TCP 80/443, proxy protocol on). Caddy gets and renews the Let's Encrypt
  certificate itself once the domain's A record points at the edge IP, and
  keeps it on the `edge-data` volume so restarts don't re-issue.
- It proxies everything to `web`, whose nginx serves the report page and
  forwards `/api/` and `/health` to `server`. Both are ClusterIP Services.
- It answers 404 for `/admin` and `/api/admin`, which have no authentication.
  Use `kubectl -n ladybug port-forward svc/server 3001`, then
  <http://localhost:3001/admin/>.

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

The server Service exposes port 3001 (the `server:3001` upstream used by nginx);
web exposes port 80 -> 8080. The web `/health` proxies to the server; web pod
probes use `/` so API outages do not restart nginx. `/api/` disables proxy buffering/cache and keeps SSE
connections open for an hour.

Workers have no HTTP health endpoint. Their readiness probe checks Valkey PING;
liveness checks that PID 1 exists. These are basic checks, not a queue-consumer
heartbeat. Workers have only sandbox pod lifecycle/log RBAC and retain outbound
access to the Kubernetes API, private databases, S3 and external analysis APIs.
The gateway is the only selected pod in `ladybug` with restricted egress. Its
Deployment bypasses the upstream image's root-only usermod/gosu entrypoint and
runs mitmdump directly as UID 1000 with the mounted CA.

## Sandboxes only

The cluster can run just the sandbox pods and the egress gateway, while the
server, worker and databases stay where they are, for example the Coolify
stack from `compose.yaml`. The sandboxes are the heavy part and the only
untrusted part, so this gets autoscaling and takes hostile pages off the main
host without moving anything else. No managed databases, Object Storage or
Load Balancer are created.

```sh
export VULTR_API_KEY=...
terraform -chdir=infra/terraform init
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
# In terraform.tfvars: sandbox_only = true, system_nodes = 1, sandbox_min_nodes
# = 2, and the region, registry name and sandbox_max_nodes you want. Set
# registry_region too if your region has no Container Registry (e.g. atl).
terraform -chdir=infra/terraform apply

export REGISTRY=$(terraform -chdir=infra/terraform output -raw registry)
terraform -chdir=infra/terraform output -raw registry_password |
  docker login "${REGISTRY%%/*}" \
    --username "$(terraform -chdir=infra/terraform output -raw registry_username)" \
    --password-stdin
export TAG=$(git rev-parse --short HEAD)
IMAGES="sandbox gateway" scripts/build-images.sh --push --latest

TAG="$TAG" infra/k8s/bootstrap.sh --sandbox-only
export KUBECONFIG="$PWD/infra/k8s/.generated/kubeconfig"
infra/k8s/test/deny-test.sh
```

Then give the worker the five settings bootstrap wrote to
`infra/k8s/.generated/worker.env` (in Coolify: the application's environment
variables) and redeploy it. To go back to sandboxes on the Docker host, remove
the five settings.

Sizing the sandbox pool:

- **Sandboxes per node.** A sandbox reserves 1 vCPU and 2 GB. The default
  `sandbox_plan` (`vc2-4c-8gb`) fits three per node. `vc2-2c-4gb` fits exactly
  one, so every sandbox gets its own node and each scan beyond the warm nodes
  adds one.
- **`WORKER_CONCURRENCY`.** Set it to what the pool can hold at its largest:
  sandboxes per node × `sandbox_max_nodes`. Scans past the warm nodes wait
  about 2 minutes for a new node; idle nodes are removed after about 10.
- **Keep three nodes in total** (`system_nodes + sandbox_min_nodes >= 3`). VKE
  runs one Calico Typha per node from three nodes up, and each holds a host
  port, so the autoscaler can't drain a node while the cluster has exactly
  three. With a lower floor, the first scale-up leaves an extra sandbox node
  running for good. `terraform plan` warns about this.
- **Changing `sandbox_plan` on an existing pool** needs
  `terraform apply -replace=vultr_kubernetes_node_pools.sandbox`; Vultr can't
  resize a pool in place.

How it fits together:

- **The worker signs in from outside** as the `remote-worker` ServiceAccount
  (`SANDBOX_KUBECONFIG_B64`). It can create, read and delete pods in `sandbox`
  and use their proxy subresource, and nothing else.
- **It reaches each sandbox through the API server's pod proxy**, since pod IPs
  aren't routable from outside. On VKE that traffic arrives from the
  `konnectivity-agent` pods in `kube-system`, and the `sandbox-api-proxy`
  NetworkPolicy lets those reach port 7000. Every screenshot and page
  snapshot crosses the control plane this way, which is fine for tens of
  scans at once.
- **Pods get the gateway's address and public CA from the `sandbox-env`
  ConfigMap** (`SANDBOX_ENV_CONFIGMAP`), which bootstrap writes.
- **A pod may wait for a node.** The worker gives a sandbox
  `SANDBOX_START_TIMEOUT_MS` (default 6 minutes) to become ready, which covers
  the autoscaler adding a node (about 2 minutes on VKE). The scan's own time
  limit starts after that.
- **Revoking the worker:** delete the `remote-worker-token` Secret in `ladybug`
  and run bootstrap again for a new one.

### Automatic deploys

`.github/workflows/deploy-sandbox-cluster.yml` runs on pushes to `dev` that
touch the sandbox or the gateway. It builds both images, pushes them, and
rolls the gateway. Sandbox pods run the `:latest` tag, which Kubernetes pulls
every time, so the next scan uses the new image. The workflow is skipped
until the `SANDBOX_REGISTRY` variable is set:

```sh
gh variable set SANDBOX_REGISTRY --body "$REGISTRY"
terraform -chdir=infra/terraform output -raw registry_username | gh secret set SANDBOX_REGISTRY_USERNAME
terraform -chdir=infra/terraform output -raw registry_password | gh secret set SANDBOX_REGISTRY_PASSWORD
gh secret set SANDBOX_DEPLOYER_KUBECONFIG < infra/k8s/.generated/deployer.kubeconfig
```

The kubeconfig belongs to the `deployer` ServiceAccount, which can only update
Deployments in `ladybug`. The worker and the sandbox image deploy separately,
so they can be a version apart for a minute or two after a push.

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
kubectl -n ladybug delete service edge --ignore-not-found
# Confirm its Vultr load balancer has disappeared, then remove infrastructure.
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
- Report reads and artifacts are readable by anyone with the scan id; the admin
  UI (where accounts are approved) is only blocked at the edge, so approve
  accounts through a port-forward.
- Rotate the gateway CA deliberately: drain scans, replace `gateway-ca`, restart
  both gateway and worker Deployments, and repeat the deny test. A subPath mount
  does not update in running gateway pods. Bootstrap preserves the existing CA.
- Add a worker heartbeat endpoint and graceful-drain behavior for scans longer
  than the current 120-second termination grace period.
