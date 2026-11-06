job "nomad-demo-traefik" {
  datacenters = ["dc1"]
  type        = "service"

  group "gateway" {
    count = 1

    network {
      port "http" {
        static = 8081
        to     = 80
      }
    }

    task "traefik" {
      driver = "docker"

      config {
        image        = "traefik:v3.6"
        ports        = ["http"]
        network_mode = "nomad-demo"
        volumes      = ["local:/etc/traefik/dynamic:ro"]
        args = [
          "--entrypoints.web.address=:80",
          "--providers.file.directory=/etc/traefik/dynamic",
          "--providers.file.watch=true",
          "--providers.providersthrottleduration=200ms",
          "--serverstransport.forwardingtimeouts.dialtimeout=1s",
        ]
      }

      template {
        destination = "local/dynamic.toml"
        change_mode = "noop"
        wait {
          min = "100ms"
          max = "300ms"
        }
        data = <<-EOF
          [http.routers.app]
            rule = "PathPrefix(`/`)"
            entryPoints = ["web"]
            service = "app"

          [http.services.app.loadBalancer]
            servers = [
          {{ range $service := nomadService "nomad-demo" }}
            {{ range $service.Tags }}
              {{ if eq . "live" }}
              { url = "http://{{ $service.Address }}:{{ $service.Port }}" },
              {{ end }}
            {{ end }}
          {{ end }}
            ]

          [http.services.app.loadBalancer.responseForwarding]
            flushInterval = "-1ms"
        EOF
      }

      resources {
        cpu    = 100
        memory = 64
      }
    }
  }
}
