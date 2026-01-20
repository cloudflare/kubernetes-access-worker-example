locals {
  common_labels = setunion(
    [
      "project:${var.project_name}",
      "environment:${var.environment}"
    ],
    var.labels
  )
}

# Module to deploy DOKS
module "digitalocean" {
  source = "./modules/digitalocean"

  project_name         = var.project_name
  environment          = var.environment
  region               = var.region
  cluster_version      = var.cluster_version
  node_pool_size       = var.node_pool_size
  node_pool_count      = var.node_pool_count
  node_pool_auto_scale = var.node_pool_auto_scale
  node_pool_min_nodes  = var.node_pool_min_nodes
  node_pool_max_nodes  = var.node_pool_max_nodes
  enable_monitoring    = var.enable_monitoring
  labels               = local.common_labels
}

# Generate CRNG bytes to use for tunnel secret
resource "random_password" "random_bytes" {
  length = 64
}

# Module to deploy k8s resources, including cloudflared deployment + Cloudflare
# Tunnel
module "k8s" {
  source = "./modules/k8s"

  cloudflare_account_id    = var.cloudflare_account_id
  cloudflare_tunnel_secret = base64sha256(random_password.random_bytes.result)
  project_name             = var.project_name
  environment              = var.environment

  depends_on = [module.digitalocean]
}

# Module to deploy Worker infrastructure, such as custom domain, Access policy,
# WVPC bindings, etc.
module "worker" {
  source                = "./modules/worker"
  subdomain             = var.subdomain
  zone_name             = var.zone_name
  cloudflare_account_id = var.cloudflare_account_id
  tunnel_id             = module.k8s.tunnel_id
}
