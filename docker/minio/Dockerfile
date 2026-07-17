FROM alpine:3.22

ARG TARGETARCH
ADD https://dl.min.io/server/minio/release/linux-${TARGETARCH}/minio /usr/local/bin/minio
ADD https://dl.min.io/client/mc/release/linux-${TARGETARCH}/mc /usr/local/bin/mc
RUN chmod 0755 /usr/local/bin/minio /usr/local/bin/mc

EXPOSE 9000 9001
ENTRYPOINT ["minio"]
