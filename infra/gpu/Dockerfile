FROM --platform=$BUILDPLATFORM golang:1.23-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc-x86-64-linux-gnu && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN GOOS=linux GOARCH=amd64 CC=x86_64-linux-gnu-gcc CGO_ENABLED=1 go build -mod=vendor -ldflags '-s -w -extldflags=-Wl,--unresolved-symbols=ignore-in-object-files' -o /nvidia-device-plugin ./cmd/nvidia-device-plugin
FROM debian:bookworm-slim
COPY --from=build /nvidia-device-plugin /usr/bin/nvidia-device-plugin
COPY --from=build /src/LICENSE /usr/share/licenses/nvidia-device-plugin/LICENSE
ENV NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=compute,utility
ENTRYPOINT ["/usr/bin/nvidia-device-plugin"]
