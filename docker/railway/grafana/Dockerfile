FROM golang:1.25-alpine AS volume-init-build
WORKDIR /src
COPY docker/railway/grafana/volume-init.go .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /volume-init volume-init.go

FROM grafana/grafana:12.3.3

COPY docker/railway/grafana/provisioning /etc/grafana/provisioning
COPY docker/railway/grafana/dashboards /etc/grafana/dashboards
COPY --from=volume-init-build /volume-init /volume-init

USER 0
ENTRYPOINT ["/volume-init", "472", "0", "/var/lib/grafana", "/run.sh"]
