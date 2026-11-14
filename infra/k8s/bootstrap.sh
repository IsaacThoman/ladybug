#!/usr/bin/env bash
set -euo pipefail
umask 077

# --sandbox-only: the cluster runs just the sandbox pods and the egress gateway.
# The server and worker stay elsewhere (e.g. Coolify) and the worker signs in
# from outside. Needs Terraform applied with sandbox_only = true.
sandbox_only=false
for arg in "$@"; do
  case "$arg" in
    --sandbox-only) sandbox_only=true ;;
    *) echo "Usage: [TAG=<tag>] infra/k8s/bootstrap.sh [--sandbox-only]" >&2; exit 1 ;;
  esac
done

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
k8s_dir="$root/infra/k8s"
generated_dir="$k8s_dir/.generated"
secrets_file="$k8s_dir/secrets.env"
for tool in terraform kubectl openssl python3 base64; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
if ! $sandbox_only; then
  if [[ ! -f "$secrets_file" ]]; then
    echo "Copy infra/k8s/secrets.example.env to infra/k8s/secrets.env and fill in the local keys." >&2
    exit 1
  fi
  # Fail before touching the cluster if local keys conflict with managed outputs.
  python3 - "$secrets_file" <<'PY'
import sys
allowed = {"LLM_API_KEY", "SAFE_BROWSING_API_KEY", "URLHAUS_AUTH_KEY", "API_KEYS"}
seen = set()
for line in open(sys.argv[1]):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    key, separator, _ = line.partition("=")
    if not separator or key not in allowed or key in seen:
        sys.exit("secrets.env must contain unique KEY=value entries for the four local keys only")
    seen.add(key)
PY
fi

output() { terraform -chdir="$root/infra/terraform" output -raw "$1"; }
registry=$(output registry)
registry=${registry%/}
if ! $sandbox_only; then
  # Assign separately so a failed Terraform output cannot be masked by printf or
  # kubectl succeeding with an empty substitution.
  database_url=$(output database_url)
  redis_url=$(output redis_url)
  s3_access_key_id=$(output s3_access_key_id)
  s3_secret_access_key=$(output s3_secret_access_key)
  s3_bucket=$(output s3_bucket)
  s3_endpoint=$(output s3_endpoint)
fi
registry_username=$(output registry_username)
registry_password=$(output registry_password)
tag=${TAG:-$(git -C "$root" rev-parse --short HEAD)}
export KUBECONFIG="$generated_dir/kubeconfig"
mkdir -p "$generated_dir"
output kubeconfig | base64 -d > "$KUBECONFIG"
# Temp files contain credentials; remove them even on a failed bootstrap.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

kubectl apply -f "$k8s_dir/namespaces.yaml"
for namespace in ladybug sandbox; do
  kubectl create secret docker-registry registry-pull --namespace "$namespace" \
    --docker-server="${registry%%/*}" --docker-username="$registry_username" \
    --docker-password="$registry_password" --dry-run=client -o yaml | kubectl apply -f -
done
unset registry_password registry_username

existing_ca=$(kubectl -n ladybug get secret gateway-ca --ignore-not-found -o name)
if [[ -z "$existing_ca" ]]; then
  cat > "$scratch/ca.cnf" <<'CA'
[req]
prompt = no
distinguished_name = dn
x509_extensions = ca
[dn]
CN = ladybug gateway CA
O = ladybug
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
CA
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
    -config "$scratch/ca.cnf" -keyout "$scratch/ca.key" -out "$scratch/ca.crt"
  cat "$scratch/ca.key" "$scratch/ca.crt" > "$scratch/mitmproxy-ca.pem"
  kubectl -n ladybug create secret generic gateway-ca \
    --from-file="mitmproxy-ca.pem=$scratch/mitmproxy-ca.pem" \
    --from-file="ca.crt=$scratch/ca.crt" --dry-run=client -o yaml | kubectl apply -f -
else
  echo "Keeping the existing gateway-ca (CA rotation must be deliberate)."
fi

if $sandbox_only; then
  for file in namespaces network-policies gateway remote-worker; do
    cp "$k8s_dir/$file.yaml" "$generated_dir/$file.yaml"
  done
  python3 - "$registry" "$tag" > "$generated_dir/kustomization.yaml" <<'PY'
import json, sys
registry, tag = sys.argv[1:]
json.dump({
    "apiVersion": "kustomize.config.k8s.io/v1beta1", "kind": "Kustomization",
    "resources": [f"{name}.yaml" for name in ("namespaces", "network-policies", "gateway", "remote-worker")],
    "images": [{"name": "ladybug-gateway", "newName": f"{registry}/ladybug-gateway", "newTag": tag}],
}, sys.stdout, indent=2)
PY
  kubectl apply -k "$generated_dir"
  kubectl -n ladybug rollout status deployment/gateway --timeout=300s

  # Sandbox pods take the gateway's address and public CA from this ConfigMap,
  # so the worker outside the cluster doesn't have to know either.
  gateway_ip=$(kubectl -n ladybug get service gateway -o jsonpath='{.spec.clusterIP}')
  kubectl -n ladybug get secret gateway-ca -o jsonpath='{.data.ca\.crt}' | base64 -d > "$scratch/ca.crt"
  kubectl -n sandbox create configmap sandbox-env \
    --from-literal="PROXY_URL=http://$gateway_ip:8080" \
    --from-file="GATEWAY_CA_PEM=$scratch/ca.crt" --dry-run=client -o yaml | kubectl apply -f -

  # Kubeconfigs for the two ServiceAccounts, holding nothing but their own token.
  server=$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.server}')
  cluster_ca=$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
  account_kubeconfig() {
    local token=""
    for _ in $(seq 30); do
      token=$(kubectl -n ladybug get secret "$1-token" -o jsonpath='{.data.token}' | base64 -d)
      [[ -n "$token" ]] && break
      sleep 1
    done
    [[ -n "$token" ]] || { echo "No token for ServiceAccount $1 yet; run bootstrap again." >&2; exit 1; }
    cat <<YAML
apiVersion: v1
kind: Config
clusters:
  - name: ladybug
    cluster:
      server: $server
      certificate-authority-data: $cluster_ca
users:
  - name: $1
    user:
      token: $token
contexts:
  - name: ladybug
    context:
      cluster: ladybug
      user: $1
current-context: ladybug
YAML
  }
  account_kubeconfig remote-worker > "$generated_dir/remote-worker.kubeconfig"
  account_kubeconfig deployer > "$generated_dir/deployer.kubeconfig"
  {
    echo "SANDBOX_PROVIDER=k8s"
    echo "SANDBOX_KUBECONFIG_B64=$(base64 < "$generated_dir/remote-worker.kubeconfig" | tr -d '\n')"
    echo "SANDBOX_IMAGE=$registry/ladybug-sandbox:${SANDBOX_TAG:-latest}"
    echo "SANDBOX_IMAGE_PULL_SECRET=registry-pull"
    echo "SANDBOX_ENV_CONFIGMAP=sandbox-env"
  } > "$generated_dir/worker.env"

  echo "Bootstrap complete. Run infra/k8s/test/deny-test.sh before accepting scan URLs."
  echo "Worker settings (for Coolify's environment variables): $generated_dir/worker.env"
  echo "Deploy workflow kubeconfig: $generated_dir/deployer.kubeconfig (see infra/README.md)"
  exit 0
fi

# Keep the Typesense key stable across bootstraps; generate one the first time.
typesense_key=$(kubectl -n ladybug get secret ladybug-secrets --ignore-not-found \
  -o jsonpath='{.data.TYPESENSE_API_KEY}' | base64 -d)
[[ -n "$typesense_key" ]] || typesense_key=$(openssl rand -hex 24)
{
  printf 'TYPESENSE_API_KEY=%s\n' "$typesense_key"
  printf 'DATABASE_URL=%s\n' "$database_url"
  printf 'REDIS_URL=%s\n' "$redis_url"
  printf 'S3_ACCESS_KEY_ID=%s\n' "$s3_access_key_id"
  printf 'S3_SECRET_ACCESS_KEY=%s\n' "$s3_secret_access_key"
} > "$scratch/managed.env"
kubectl -n ladybug create secret generic ladybug-secrets \
  --from-env-file="$scratch/managed.env" --from-env-file="$secrets_file" \
  --dry-run=client -o yaml | kubectl apply -f -
unset database_url redis_url s3_access_key_id s3_secret_access_key typesense_key

# A generated copy keeps the checked-in templates and their placeholders intact.
# Start with raw resources so a previous --set-images cannot override this TAG.
for file in namespaces network-policies rbac configmap gateway typesense server worker web edge image-fields; do
  cp "$k8s_dir/$file.yaml" "$generated_dir/$file.yaml"
done
kubectl -n ladybug create configmap ladybug-config --dry-run=client -o yaml \
  --from-literal="S3_BUCKET=$s3_bucket" \
  --from-literal="S3_ENDPOINT=$s3_endpoint" \
  --from-literal="S3_REGION=${S3_REGION:-us-east-1}" \
  --from-literal="WORKER_CONCURRENCY=${WORKER_CONCURRENCY:-10}" \
  --from-literal="LLM_BASE_URL=${LLM_BASE_URL:-https://api.openai.com/v1}" \
  --from-literal="LLM_MODEL=${LLM_MODEL:-}" \
  --from-literal="LLM_VISION=${LLM_VISION:-true}" \
  --from-literal="SITE_DOMAIN=${SITE_DOMAIN:-ladybugg.garden}" \
  > "$generated_dir/configmap-values.yaml"
python3 - "$registry" "$tag" > "$generated_dir/kustomization.yaml" <<'PY'
import json, sys
registry, tag = sys.argv[1:]
json.dump({
    "apiVersion": "kustomize.config.k8s.io/v1beta1", "kind": "Kustomization",
    "resources": [f"{name}.yaml" for name in
                  ("namespaces", "network-policies", "rbac", "configmap", "gateway", "typesense", "server", "worker", "web", "edge")],
    "configurations": ["image-fields.yaml"],
    "patches": [{"path": "configmap-values.yaml"}],
    "images": [{"name": f"ladybug-{name}", "newName": f"{registry}/ladybug-{name}", "newTag": tag}
               for name in ("server", "worker", "web", "gateway", "sandbox")],
}, sys.stdout, indent=2)
PY
kubectl apply -k "$generated_dir"
# envFrom and subPath mounts aren't reloaded by running containers.
kubectl -n ladybug rollout restart deployment/server deployment/worker deployment/edge
for deployment in gateway server worker web edge; do
  kubectl -n ladybug rollout status "deployment/$deployment" --timeout=300s
done
edge_ip=$(kubectl -n ladybug get service edge -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "Bootstrap complete. Run infra/k8s/test/deny-test.sh before accepting scan URLs."
echo "Point ${SITE_DOMAIN:-ladybugg.garden}'s A record at ${edge_ip:-<edge IP, still pending: kubectl -n ladybug get service edge>}."
echo "Caddy gets its HTTPS certificate once DNS resolves to that IP."
