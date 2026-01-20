variable "worker_name" {
  description = "The name of the Cloudflare Worker"
  type        = string
  default     = "kube-proxy-worker"
}

variable "subdomain" {
  description = "Subdomain to serve worker on"
  type        = string
}

variable "zone_name" {
  description = "The name of your Cloudflare zone"
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "tunnel_id" {
  description = "ID of Cloudflare Tunnel running within your Kubernetes cluster"
  type        = string
}