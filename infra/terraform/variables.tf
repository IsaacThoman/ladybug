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

variable "kubernetes_version" {
  description = "VKE version. null = the latest Vultr offers."
  type        = string
  default     = null
}

variable "system_plan" {
  description = "Plan for the always-on system pool (server, worker, web, gateway)."
  type        = string
  default     = "vc2-2c-4gb"
}

variable "system_nodes" {
  type    = number
  default = 2
}

variable "sandbox_plan" {
  description = "Plan for the sandbox pool. 4 vCPU / 8 GB fits ~3 sandboxes per node."
  type        = string
  default     = "vc2-4c-8gb"
}

variable "sandbox_min_nodes" {
  description = "Keep this high enough for the demo batch so the autoscaler isn't on the critical path."
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
  description = "Managed Valkey plan (same plans list as Postgres)."
  type        = string
  default     = "vultr-dbaas-hobbyist-cc-1-25-1"
}

variable "object_storage_tier_slug" {
  description = "Object Storage tier. List options: curl -H \"Authorization: Bearer $VULTR_API_KEY\" https://api.vultr.com/v2/object-storage/tiers"
  type        = string
  default     = "tier_010k_5000m"
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

variable "registry_plan" {
  type    = string
  default = "start_up"
}
