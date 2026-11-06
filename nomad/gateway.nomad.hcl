job "nomad-demo-gateway" {
  datacenters = ["dc1"]
  type        = "service"

  group "gateway" {
    count = 1
    network {

      port "http" {
        static = 8080
        to     = 80
      }
    }

    task "nginx" {
      driver = "docker"
      config {
        image        = "nginx:1.28-alpine"
        network_mode = "nomad-demo"
        ports        = ["http"]
        volumes = ["local:/etc/nginx/conf.d:ro"]
      }

      # 正式实例使用 live 标签，canary 使用 preview 标签；promote 后 Nomad 更新标签。
      # SIGHUP 平滑加载新 upstream，已有长连接由旧 worker 继续处理。
      template {
        destination   = "local/default.conf"
        change_mode   = "signal"
        change_signal = "SIGHUP"
        wait {
          min = "100ms"
          max = "300ms"
        }
        data = <<-EOF
          upstream app {
            server 127.0.0.1:9 down;
          {{ range $service := nomadService "nomad-demo" }}
            {{ range $service.Tags }}
              {{ if eq . "live" }}
            server {{ $service.Address }}:{{ $service.Port }};
              {{ end }}
            {{ end }}
          {{ end }}
          }
          map $http_upgrade $connection_upgrade {
            default upgrade;
            '' close;
          }
          server {
            listen 80;
            location / {
              proxy_pass http://app;
              proxy_http_version 1.1;
              proxy_set_header Host $host;
              proxy_set_header Upgrade $http_upgrade;
              proxy_set_header Connection $connection_upgrade;
              proxy_buffering off;
              proxy_cache off;
              proxy_connect_timeout 1s;
              proxy_read_timeout 1h;
              proxy_send_timeout 1h;
            }
          }
        EOF
      }
      resources {
        cpu    = 100
        memory = 64
      }
    }
  }
}
