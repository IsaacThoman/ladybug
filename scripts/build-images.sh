#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
usage() {
  echo "Usage: REGISTRY=<region>.vultrcr.com/<name> TAG=<tag> [IMAGES=\"sandbox gateway\"] scripts/build-images.sh [--push] [--latest] [--set-images]"
}
push=false
latest=false
set_images=false
for arg in "$@"; do
  case "$arg" in
    --push) push=true ;;
    # Also tag each image `latest`. Sandbox pods started from `:latest` always pull it.
    --latest) latest=true ;;
    --set-images) set_images=true ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
done
: "${REGISTRY:?Set REGISTRY to <region>.vultrcr.com/<name>}"
registry=${REGISTRY%/}
tag=${TAG:-$(git -C "$root" rev-parse --short HEAD)}
# A subset, e.g. IMAGES="sandbox gateway" for a cluster that only runs sandboxes.
read -ra images <<< "${IMAGES:-server worker web sandbox gateway}"
if $set_images; then
  command -v kustomize >/dev/null || { echo "--set-images requires kustomize" >&2; exit 1; }
fi
output_flag=--load
if $push; then output_flag=--push; fi
for name in "${images[@]}"; do
  dockerfile="apps/$name/Dockerfile"
  if [[ "$name" == gateway ]]; then dockerfile=infra/gateway/Dockerfile; fi
  tags=(-t "$registry/ladybug-$name:$tag")
  if $latest; then tags+=(-t "$registry/ladybug-$name:latest"); fi
  docker buildx build --platform linux/amd64 "$output_flag" \
    -f "$root/$dockerfile" "${tags[@]}" "$root"
done
if $set_images; then
  (
    cd "$root/infra/k8s"
    for name in "${images[@]}"; do
      kustomize edit set image "ladybug-$name=$registry/ladybug-$name:$tag"
    done
  )
else
  echo "To update the base image references (including SANDBOX_IMAGE):"
  printf 'cd %q\n' "$root/infra/k8s"
  for name in "${images[@]}"; do
    printf 'kustomize edit set image %q\n' "ladybug-$name=$registry/ladybug-$name:$tag"
  done
fi
printf 'Bootstrap with the same tag: TAG=%q infra/k8s/bootstrap.sh\n' "$tag"
