terraform {
  required_version = ">= 1.6"
  required_providers {
    vultr = {
      source  = "vultr/vultr"
      version = "~> 2.33"
    }
  }
}

provider "vultr" {
  # Or set VULTR_API_KEY in the environment and leave this null.
  api_key     = var.vultr_api_key
  rate_limit  = 700
  retry_limit = 5
}
