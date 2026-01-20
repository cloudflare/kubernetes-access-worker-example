variable "cloudflare_api_token" {
  description = "Cloudflare API token"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "do_token" {
  description = "DigitalOcean API token"
  type        = string
  sensitive   = true
}

variable "project_name" {
  description = "Name of the project"
  type        = string
  default     = "kube-access-worker"
}

variable "environment" {
  description = "The deployment environment"
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev"], var.environment)
    error_message = "The environment variable must be one of: ['dev']"
  }
}

variable "region" {
  description = "DigitalOcean region"
  type        = string
  default     = "nyc3"
}

variable "cluster_version" {
  description = "Kubernetes version"
  type        = string
  default     = "latest"
}

variable "node_pool_size" {
  description = "Droplet size for node pool"
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "node_pool_count" {
  description = "Number of nodes in the default pool"
  type        = number
  default     = 2
}

variable "node_pool_auto_scale" {
  description = "Enable auto-scaling for node pool"
  type        = bool
  default     = true
}

variable "node_pool_min_nodes" {
  description = "Minimum number of nodes when auto-scaling"
  type        = number
  default     = 2
}

variable "node_pool_max_nodes" {
  description = "Maximum number of nodes when auto-scaling"
  type        = number
  default     = 5
}

variable "enable_monitoring" {
  description = "Enable DigitalOcean monitoring for the cluster"
  type        = bool
  default     = true
}

variable "labels" {
  description = "Additional labels to apply to DigitalOcean resources"
  type        = set(string)
  default     = []
}

variable "subdomain" {
  description = "Subdomain to serve worker on"
  type        = string
}

variable "zone_name" {
  description = "The name of your Cloudflare zone"
  type        = string
}
