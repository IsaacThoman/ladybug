#!/usr/bin/env bash
set -euo pipefail

for tool in kubectl python3 base64; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
pod="deny-test-$$-$RANDOM"
scratch=$(mktemp -d)
cleanup() {
  kubectl -n sandbox delete pod "$pod" --ignore-not-found --wait=false >/dev/null || true
  rm -rf "$scratch"
}
trap cleanup EXIT
kubectl -n ladybug rollout status deployment/gateway --timeout=180s
gateway_ip=$(kubectl -n ladybug get service gateway -o jsonpath='{.spec.clusterIP}')
dns_ip=$(kubectl -n kube-system get service kube-dns -o jsonpath='{.spec.clusterIP}')
# Resolve outside the restricted pod, so the direct test cannot pass just because
# DNS is blocked. Use -k and no --fail: ANY direct HTTP response is a failure.
public_ip=$(python3 -c 'import socket; print(socket.gethostbyname("example.com"))')
kubectl -n ladybug get secret gateway-ca -o jsonpath='{.data.ca\.crt}' | base64 -d > "$scratch/ca.crt"

kubectl create -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: $pod
  namespace: sandbox
  labels:
    app.kubernetes.io/name: ladybug-sandbox
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 300
  automountServiceAccountToken: false
  nodeSelector:
    pool: sandbox
  tolerations:
    - key: pool
      operator: Equal
      value: sandbox
      effect: NoSchedule
  securityContext:
    runAsNonRoot: true
    runAsUser: 100
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: curl
      image: curlimages/curl:8.17.0
      command: [sh, -c, "sleep 300"]
      resources:
        requests:
          cpu: 10m
          memory: 16Mi
        limits:
          cpu: 100m
          memory: 64Mi
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: [ALL]
YAML
kubectl -n sandbox wait --for=condition=Ready "pod/$pod" --timeout=180s
kubectl -n sandbox exec "$pod" -- sh -c 'command -v nslookup && command -v timeout' >/dev/null
kubectl -n sandbox exec -i "$pod" -- sh -c 'cat > /tmp/gateway-ca.crt' < "$scratch/ca.crt"
proxy="http://$gateway_ip:8080"
failures=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

if kubectl -n sandbox exec "$pod" -- curl --silent --show-error --fail --max-time 20 \
  --noproxy '' --proxy "$proxy" --proxy-user test:x --cacert /tmp/gateway-ca.crt \
  https://example.com > "$scratch/proxy.out" 2>&1; then
  pass "HTTPS through the gateway with its CA"
else
  cat "$scratch/proxy.out"
  fail "HTTPS through the gateway"
fi

status=0
kubectl -n sandbox exec "$pod" -- curl --silent --show-error --insecure --max-time 10 \
  --proxy '' --noproxy '*' --resolve "example.com:443:$public_ip" https://example.com \
  > "$scratch/direct.out" 2>&1 || status=$?
if [[ "$status" == 7 || "$status" == 28 ]]; then
  pass "direct HTTPS blocked (DNS bypassed)"
else
  cat "$scratch/direct.out"
  fail "direct HTTPS must time out or be refused; exit=$status"
fi

status=0
kubectl -n sandbox exec "$pod" -- timeout 10 nslookup example.com "$dns_ip" \
  > "$scratch/dns.out" 2>&1 || status=$?
if [[ "$status" == 124 ]] || { [[ "$status" == 1 ]] && \
  LC_ALL=C grep -Eiq 'timed out|no servers could be reached|connection refused' "$scratch/dns.out"; }; then
  pass "DNS to the real cluster resolver blocked"
else
  cat "$scratch/dns.out"
  fail "DNS must fail due to blocked connectivity; exit=$status"
fi

status=0
code=$(kubectl -n sandbox exec "$pod" -- curl --silent --show-error --max-time 15 \
  --noproxy '' --proxy "$proxy" --proxy-user test:x --output /tmp/metadata-response \
  --write-out '%{http_code}' http://169.254.169.254/) || status=$?
if [[ "$status" == 0 && "$code" == 502 ]] && \
  kubectl -n sandbox exec "$pod" -- grep -q 'ladybug gateway:.*non-public' /tmp/metadata-response; then
  pass "gateway explicitly refuses the metadata IP"
else
  fail "metadata request must get gateway rejection HTTP 502; exit=$status HTTP=$code"
fi

if (( failures > 0 )); then
  echo "FAIL: $failures NetworkPolicy/gateway check(s) failed" >&2
  exit 1
fi
echo "PASS: all NetworkPolicy/gateway checks"
