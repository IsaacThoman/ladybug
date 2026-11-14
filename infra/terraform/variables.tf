variable "vultr_api_key" {
  description = "Vultr API key. Leave null to use the VULTR_API_KEY environment variable."
  type        = string
  default     = null
  sensitive   = true
}

variable "region" {
  description = "Vultr region for everything (must offer VKE, Managed Databases and Object Storage)."
  type        = string
  default     = "sjc"
}

variable "name" {
  description = "Prefix for resource labels."
  type        = string
  default     = "ladybug"
}

variable "sandbox_only" {
  description = "Create only the cluster and the registry: no managed databases or Object Storage. For when the server and worker run elsewhere (e.g. Coolify) and use this cluster just for sandboxes."
  type        = bool
  default     = false
}

variable "kubernetes_version" {
  description = "VKE version. null = the latest Vultr offers."
  type        = string
  default     = null
}

variable "system_plan" {
  description = "Plan for the always-on system pool (server, worker, web, gateway; just the gateway with sandbox_only)."
  type        = string
  default     = "vc2-2c-4gb"
}

variable "system_nodes" {
  type    = number
  default = 2
}

variable "sandbox_plan" {
  description = "Plan for the sandbox pool. 4 vCPU / 8 GB (vc2-4c-8gb) fits 3 sandboxes per node; 2 vCPU / 4 GB (vc2-2c-4gb) fits one, so every sandbox gets its own node."
  type        = string
  default     = "vc2-4c-8gb"
}

variable "sandbox_min_nodes" {
  description = "Sandbox nodes kept running. Keep system_nodes + sandbox_min_nodes at 3 or more: once a VKE cluster has had three nodes, the autoscaler can't shrink it below three."
  type        = number
  default     = 2
}

variable "sandbox_max_nodes" {
  type    = number
  default = 6
}

variable "postgres_plan" {
  description = "Managed Postgres plan. List options: curl -H \"Authorization: Bearer $VULTR_API_KEY\" https://api.vultr.com/v2/databases/plans"
  type        = string
  default     = "vultr-dbaas-hobbyist-cc-1-25-1"
}

variable "valkey_plan" {
  description = "Managed Valkey plan (same plans list as Postgres; pick one whose supported_engines includes valkey)."
  type        = string
  default     = "vultr-dbaas-hobbyist-rp-intel-1-11-1"
}

variable "object_storage_tier_slug" {
  description = "Object Storage tier. List options: curl -H \"Authorization: Bearer $VULTR_API_KEY\" https://api.vultr.com/v2/object-storage/tiers"
  type        = string
  default     = "tier_008h_0600m"
}

variable "artifacts_bucket" {
  description = "Bucket for screenshots, HAR files and reports. Bucket names are global per Object Storage cluster."
  type        = string
  default     = "ladybug-artifacts"
}

variable "registry_name" {
  description = "Container Registry name (lowercase letters and digits, globally unique)."
  type        = string
  default     = "ladybug"
}

variable "registry_region" {
  description = "Region for the Container Registry, which fewer regions offer (e.g. not atl). null = the same as region. List options: curl https://api.vultr.com/v2/registry/region/list"
  type        = string
  default     = null
}

variable "registry_plan" {
  type    = string
  default = "start_up"
}
