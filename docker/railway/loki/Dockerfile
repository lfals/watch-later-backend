FROM golang:1.25-alpine AS volume-init-build
WORKDIR /src
COPY volume-init.go .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /volume-init volume-init.go

FROM grafana/loki:3.7.0

COPY loki-config.yml /etc/loki/watch-later.yml
COPY --from=volume-init-build /volume-init /volume-init

USER 0
ENTRYPOINT ["/volume-init", "10001", "10001", "/loki", "/usr/bin/loki"]
CMD ["-config.file=/etc/loki/watch-later.yml", "-config.expand-env=true"]
