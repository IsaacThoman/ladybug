data "vultr_kubernetes_kubeconfig" "main" {
  cluster_id = vultr_kubernetes.main.id
}

output "kubeconfig" {
  description = "terraform output -raw kubeconfig | base64 -d > ~/.kube/ladybug.yaml"
  value       = data.vultr_kubernetes_kubeconfig.main.kube_config
  sensitive   = true
}

output "cluster_endpoint" {
  value = vultr_kubernetes.main.endpoint
}

# The database and Object Storage outputs are null with sandbox_only.

output "database_url" {
  description = "Postgres URL over the VPC. Set DATABASE_SSL=true."
  value       = one([for db in vultr_database.postgres : "postgres://${db.user}:${urlencode(db.password)}@${db.host}:${db.port}/${db.dbname}"])
  sensitive   = true
}

output "redis_url" {
  description = "Valkey URL over the VPC (TLS)."
  value       = one([for db in vultr_database.valkey : "rediss://${db.user}:${urlencode(db.password)}@${db.host}:${db.port}"])
  sensitive   = true
}

output "s3_endpoint" {
  value = one([for store in vultr_object_storage.main : "https://${store.s3_hostname}"])
}

output "s3_bucket" {
  value = one(vultr_object_storage_bucket.artifacts[*].name)
}

output "s3_access_key_id" {
  value     = one(vultr_object_storage.main[*].s3_access_key)
  sensitive = true
}

output "s3_secret_access_key" {
  value     = one(vultr_object_storage.main[*].s3_secret_key)
  sensitive = true
}

output "registry" {
  description = "Image prefix, e.g. <registry>/ladybug-server:<tag>."
  value       = "${local.registry_region}.vultrcr.com/${vultr_container_registry.main.name}"
}

output "registry_username" {
  value     = vultr_container_registry.main.root_user["username"]
  sensitive = true
}

output "registry_password" {
  value     = vultr_container_registry.main.root_user["password"]
  sensitive = true
}
