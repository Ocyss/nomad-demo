variable "image" { type = string }
variable "version" { type = string }

job "nomad-demo" {
  datacenters = ["dc1"]
  type        = "service"

  group "app" {
    count = 1

    update {
      max_parallel      = 1
      canary            = 1
      auto_promote      = true
      auto_revert       = true
      min_healthy_time  = "5s"
      healthy_deadline  = "2m"
      progress_deadline = "5m"
    }

    network {
      port "http" { to = 3000 }
    }

    task "app" {
      driver       = "docker"
      kill_signal  = "SIGTERM"
      kill_timeout   = "10s"
      shutdown_delay = "10s"
      config {
        image        = var.image
        network_mode = "nomad-demo"
        ports        = ["http"]
        force_pull   = false
      }

      # 网关使用 driver 容器地址；动态宿主机映射仅供 Nomad 原生健康检查。
      service {
        name         = "nomad-demo"
        provider     = "nomad"
        address_mode = "driver"
        port         = "http"
        tags         = ["live"]
        canary_tags  = ["preview"]

        check {

          type     = "http"
          path     = "/health"
          interval = "2s"
          timeout  = "1s"
        }
      }

      env {
        PORT        = "3000"
        APP_VERSION = var.version
      }
      resources {
        cpu    = 100
        memory = 128
      }
    }
  }
}
