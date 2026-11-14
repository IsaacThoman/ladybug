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

output "database_url" {
  description = "Postgres URL over the VPC. Set DATABASE_SSL=true."
  value       = "postgres://${vultr_database.postgres.user}:${urlencode(vultr_database.postgres.password)}@${vultr_database.postgres.host}:${vultr_database.postgres.port}/${vultr_database.postgres.dbname}"
  sensitive   = true
}

output "redis_url" {
  description = "Valkey URL over the VPC (TLS)."
  value       = "rediss://${vultr_database.valkey.user}:${urlencode(vultr_database.valkey.password)}@${vultr_database.valkey.host}:${vultr_database.valkey.port}"
  sensitive   = true
}

output "s3_endpoint" {
  value = "https://${vultr_object_storage.main.s3_hostname}"
}

output "s3_bucket" {
  value = vultr_object_storage_bucket.artifacts.name
}

output "s3_access_key_id" {
  value     = vultr_object_storage.main.s3_access_key
  sensitive = true
}

output "s3_secret_access_key" {
  value     = vultr_object_storage.main.s3_secret_key
  sensitive = true
}

output "registry" {
  description = "Image prefix, e.g. <registry>/ladybug-server:<tag>."
  value       = "${var.region}.vultrcr.com/${vultr_container_registry.main.name}"
}

output "registry_username" {
  value     = vultr_container_registry.main.root_user["username"]
  sensitive = true
}

output "registry_password" {
  value     = vultr_container_registry.main.root_user["password"]
  sensitive = true
}
