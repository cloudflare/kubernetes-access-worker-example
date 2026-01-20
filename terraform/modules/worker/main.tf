# Get zone ID
data "cloudflare_zones" "search" {
  name = var.zone_name
  account = {
    id = var.cloudflare_account_id
  }
}
data "cloudflare_zone" "zone" {
  zone_id = data.cloudflare_zones.search.result.0.id
}

# Associate custom domain to proxy worker
resource "cloudflare_workers_custom_domain" "worker_domain" {
  account_id = var.cloudflare_account_id
  service    = var.worker_name
  hostname   = "${var.subdomain}.${var.zone_name}"
  zone_id    = data.cloudflare_zone.zone.id

  # Without this TF thinks there is plan drift every time
  lifecycle {
    ignore_changes = [environment]
  }
}

# Create the Access Application to protect the worker
resource "cloudflare_zero_trust_access_application" "worker_access_app" {
  account_id       = var.cloudflare_account_id
  name             = "Kube Proxy Worker"
  type             = "self_hosted"
  domain           = cloudflare_workers_custom_domain.worker_domain.hostname
  session_duration = "24h"

  policies = [{
    id         = cloudflare_zero_trust_access_policy.policy.id
    precedence = 1
  }]

  # Allow user's WARP session to authenticate to this application
  allow_authenticate_via_warp = true
  # Does not work with WARP sessions
  enable_binding_cookie = false
  app_launcher_visible  = false
}

# And a policy to grant access to it
resource "cloudflare_zero_trust_access_policy" "policy" {
  account_id       = var.cloudflare_account_id
  name             = "Kube Proxy Worker Policy"
  session_duration = "24h"

  decision = "allow"
  include = [{
    email_domain = {
      domain = "mydomain.com"
    }
  }]
}

resource "cloudflare_connectivity_directory_service" "kube_wvpc_service" {
  account_id = var.cloudflare_account_id
  host = {
    hostname = "localhost"
    resolver_network = {
      tunnel_id = var.tunnel_id
    }
  }
  name      = "kube-api-server"
  type      = "http"
  http_port = 8001
}

