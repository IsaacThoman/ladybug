data "vultr_kubernetes_version" "current" {}

locals {
  kubernetes_version = coalesce(var.kubernetes_version, data.vultr_kubernetes_version.current.latest)
  # Databases and Object Storage, skipped when the cluster only runs sandboxes.
  data_services   = var.sandbox_only ? 0 : 1
  registry_region = coalesce(var.registry_region, var.region)
}

resource "vultr_vpc" "main" {
  region         = var.region
  description    = "${var.name} private network"
  v4_subnet      = "10.40.0.0"
  v4_subnet_mask = 20
}

# ---------------------------------------------------------------------------
# Kubernetes: a small always-on system pool plus an autoscaling, tainted pool
# that only sandbox pods tolerate.

resource "vultr_kubernetes" "main" {
  region  = var.region
  label   = var.name
  version = local.kubernetes_version
  vpc_id  = vultr_vpc.main.id

  node_pools {
    label         = "${var.name}-system"
    plan          = var.system_plan
    node_quantity = var.system_nodes
    auto_scaler   = false

    labels {
      key   = "pool"
      value = "system"
    }
  }

  # VKE keeps the first pool in the cluster resource; later pools are
  # separate resources, so ignore drift in node counts from autoscaling.
  lifecycle {
    ignore_changes = [node_pools[0].node_quantity]
  }
}

resource "vultr_kubernetes_node_pools" "sandbox" {
  cluster_id    = vultr_kubernetes.main.id
  label         = "${var.name}-sandbox"
  plan          = var.sandbox_plan
  node_quantity = var.sandbox_min_nodes
  auto_scaler   = true
  min_nodes     = var.sandbox_min_nodes
  max_nodes     = var.sandbox_max_nodes

  labels {
    key   = "pool"
    value = "sandbox"
  }

  taints {
    key    = "pool"
    value  = "sandbox"
    effect = "NoSchedule"
  }

  lifecycle {
    ignore_changes = [node_quantity]
  }
}

# ---------------------------------------------------------------------------
# Managed databases, reachable only over the VPC.

resource "vultr_database" "postgres" {
  count                   = local.data_services
  label                   = "${var.name}-postgres"
  region                  = var.region
  database_engine         = "pg"
  database_engine_version = "17"
  plan                    = var.postgres_plan
  vpc_id                  = vultr_vpc.main.id
}

resource "vultr_database" "valkey" {
  count                   = local.data_services
  label                   = "${var.name}-valkey"
  region                  = var.region
  database_engine         = "valkey"
  database_engine_version = "8"
  plan                    = var.valkey_plan
  vpc_id                  = vultr_vpc.main.id
  # BullMQ needs keys to stay put.
  eviction_policy = "noeviction"
}

# ---------------------------------------------------------------------------
# Object Storage for artifacts.

data "vultr_object_storage_cluster" "main" {
  count = local.data_services

  filter {
    name   = "region"
    values = [var.region]
  }
}

data "vultr_object_storage_tier" "main" {
  count = local.data_services

  filter {
    name   = "slug"
    values = [var.object_storage_tier_slug]
  }
}

resource "vultr_object_storage" "main" {
  count      = local.data_services
  label      = "${var.name}-artifacts"
  cluster_id = data.vultr_object_storage_cluster.main[0].id
  tier_id    = data.vultr_object_storage_tier.main[0].id
}

resource "vultr_object_storage_bucket" "artifacts" {
  count             = local.data_services
  object_storage_id = vultr_object_storage.main[0].id
  name              = var.artifacts_bucket
}

# ---------------------------------------------------------------------------
# Container Registry for the five images.

resource "vultr_container_registry" "main" {
  name   = var.registry_name
  region = local.registry_region
  plan   = var.registry_plan
  public = false
}
