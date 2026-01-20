locals {
  common_labels = {
    app         = "cloudflared"
    managed-by  = "terraform"
    environment = var.environment
  }
}

resource "kubernetes_namespace_v1" "cloudflared" {
  metadata {
    name   = "cloudflared"
    labels = local.common_labels
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "tunnel" {
  account_id    = var.cloudflare_account_id
  name          = "${var.project_name}-${var.environment}-k8s-tunnel"
  config_src    = "local"
  tunnel_secret = var.cloudflare_tunnel_secret
}

# Store tunnel credentials in Kubernetes secret
resource "kubernetes_secret_v1" "cloudflared_creds" {
  metadata {
    name      = "cloudflared-credentials"
    namespace = kubernetes_namespace_v1.cloudflared.metadata[0].name
    labels    = local.common_labels
  }
  data = {
    "credentials.json" = jsonencode({
      AccountTag   = var.cloudflare_account_id
      TunnelID     = cloudflare_zero_trust_tunnel_cloudflared.tunnel.id
      TunnelSecret = var.cloudflare_tunnel_secret
    })
  }

  type = "Opaque"
}

# cloudflared config
resource "kubernetes_config_map_v1" "cloudflared_config" {
  metadata {
    name      = "cloudflared-config"
    namespace = kubernetes_namespace_v1.cloudflared.metadata[0].name
    labels    = local.common_labels
  }
  data = {
    "config.yaml" = yamlencode({
      tunnel             = cloudflare_zero_trust_tunnel_cloudflared.tunnel.id
      "credentials-file" = "/etc/cloudflared/creds/credentials.json"
      # Serves the Prometheus metrics server under /metrics and the readiness
      # server under /ready
      metrics = "0.0.0.0:2000"
      # Autoupdates applied in a k8s pod will be lost when the pod is removed or
      # restarted, so autoupdate doesn't make sense in Kubernetes.
      "no-autoupdate" = true
    })
  }
}

resource "kubernetes_deployment_v1" "cloudflared" {
  metadata {
    name      = "cloudflared"
    namespace = kubernetes_namespace_v1.cloudflared.metadata[0].name
    labels    = local.common_labels
  }

  spec {
    replicas = var.replica_count

    selector {
      match_labels = {
        app = "cloudflared"
      }
    }

    template {
      metadata {
        labels = local.common_labels
        annotations = {
          "prometheus.io/scrape" = "true"
          "prometheus.io/port"   = "2000"
          "prometheus.io/path"   = "/metrics"
          # The hash changes whenever the config map data changes
          "config_checksum" = sha1(jsonencode(kubernetes_config_map_v1.cloudflared_config.data))
        }
      }

      spec {
        container {
          name  = "kubectl-proxy"
          image = "bitnami/kubectl:latest"

          args = ["proxy", "--v=10", "--disable-filter"]

          port {
            container_port = 8001
            name           = "proxy"
            protocol       = "TCP"
          }

          volume_mount {
            name = "sa-token"
            # Standard path for in-cluster auth that kubectl will read
            mount_path = "/var/run/secrets/kubernetes.io/serviceaccount"
            read_only  = true
          }
        }

        container {
          name  = "cloudflared"
          image = var.cloudflared_image

          args = ["tunnel", "--config", "/etc/cloudflared/config/config.yaml", "run"]

          liveness_probe {
            # Cloudflared has a /ready endpoint which returns 200 if and only if
            # it has an active connection to the edge.
            http_get {
              path = "/ready"
              port = 2000
            }
            failure_threshold     = 1
            initial_delay_seconds = 10
            period_seconds        = 10
          }

          volume_mount {
            name       = "config"
            mount_path = "/etc/cloudflared/config"
            read_only  = true
          }

          volume_mount {
            name       = "creds"
            mount_path = "/etc/cloudflared/creds"
            read_only  = true
          }

          resources {
            requests = var.resource_requirements.requests
            limits   = var.resource_requirements.limits
          }

          security_context {
            # sudo not allowed
            allow_privilege_escalation = false
            read_only_root_filesystem  = true
            # Drops all default Linux capabilities
            capabilities {
              drop = ["ALL"]
            }
          }
        }

        volume {
          name = "config"
          config_map {
            name = kubernetes_config_map_v1.cloudflared_config.metadata[0].name
            items {
              key  = "config.yaml"
              path = "config.yaml"
            }
          }
        }

        volume {
          name = "creds"
          secret {
            secret_name = kubernetes_secret_v1.cloudflared_creds.metadata[0].name
          }
        }

        # Explicit mounting is safer. Allows us to control expiration of token
        # and only mount in kubectl proxy container
        automount_service_account_token = false
        volume {
          name = "sa-token"
          projected {
            sources {
              config_map {
                # Upstream Kube API server TLS cert
                name = "kube-root-ca.crt"
                items {
                  key  = "ca.crt"
                  path = "ca.crt"
                }
              }
            }
            sources {
              service_account_token {
                path = "token"
                # 1 hour expiration. Auto-rotated
                expiration_seconds = 3600
              }
            }
          }
        }

        # Use a dedicated service account
        service_account_name = kubernetes_service_account_v1.cloudflared.metadata[0].name

        security_context {
          # This setting is required to allow ICMP (ping) to work within the
          # container. It broadens the kernel's allowed GID range for opening
          # ICMP sockets.
          sysctl {
            name  = "net.ipv4.ping_group_range"
            value = "65532 65532"
          }
          run_as_non_root = true
          run_as_user     = 65532
          run_as_group    = 65532
          fs_group        = 65532
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
      }
    }
    strategy {
      type = "RollingUpdate"
      rolling_update {
        max_surge       = 1
        max_unavailable = 1
      }
    }
  }
}

resource "kubernetes_service_account_v1" "cloudflared" {
  metadata {
    name      = "cloudflared"
    namespace = kubernetes_namespace_v1.cloudflared.metadata[0].name
    labels    = local.common_labels
  }
}

resource "kubernetes_cluster_role_v1" "cloudflared_cluster_role" {
  metadata {
    name   = "cloudflared-cluster-role"
    labels = local.common_labels
  }

  # Give "impersonate" permission so our pod can use k8s impersonation headers
  #
  # Worker will inject impersonation headers before proxying over to this tunnel
  rule {
    api_groups = [""]
    resources  = ["users", "groups"]
    verbs      = ["impersonate"]
  }
}

resource "kubernetes_cluster_role_binding_v1" "cloudflared_cluster_role_binding" {
  metadata {
    name   = "cloudflared-cluster-role-binding"
    labels = local.common_labels
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role_v1.cloudflared_cluster_role.metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.cloudflared.metadata[0].name
    namespace = kubernetes_namespace_v1.cloudflared.metadata[0].name
  }
}

# Service for metrics endpoint
resource "kubernetes_service_v1" "cloudflared_metrics" {
  metadata {
    name      = "cloudflared-metrics"
    namespace = kubernetes_namespace_v1.cloudflared.metadata[0].name
    labels    = local.common_labels
  }

  spec {
    selector = {
      app = "cloudflared"
    }

    port {
      name        = "metrics"
      port        = 2000
      target_port = 2000
      protocol    = "TCP"
    }

    type = "ClusterIP"
  }
}

