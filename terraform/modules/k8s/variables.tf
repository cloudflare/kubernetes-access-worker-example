variable "project_name" {
  description = "Name of the DigitalOcean project"
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_tunnel_secret" {
  description = "Cloudflare tunnel secret (base64 encoded 32-byte secret)"
  type        = string
  sensitive   = true
}

variable "cloudflared_image" {
  description = "Cloudflared container image"
  type        = string
  default     = "cloudflare/cloudflared:latest"
}

variable "environment" {
  description = "Environment name"
  type        = string
}

variable "replica_count" {
  description = "Number of cloudflared replicas"
  type        = number
  default     = 1
}

variable "resource_requirements" {
  description = "Defines the Kubernetes CPU and memory requests and limits for the cloudflared container."
  type = object({
    requests = object({
      cpu    = string
      memory = string
    })
    limits = object({
      cpu    = string
      memory = string
    })
  })

  default = {
    requests = {
      cpu    = "200m"  # 0.2 CPU core
      memory = "128Mi" # 128 Megabytes
    }
    limits = {
      cpu    = "500m"  # 0.5 CPU core
      memory = "512Mi" # 512 Megabytes
    }
  }

  nullable = true
}