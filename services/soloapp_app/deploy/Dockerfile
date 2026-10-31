FROM ubuntu:24.04 AS toolchain
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates g++ cmake make git libjsoncpp-dev uuid-dev zlib1g-dev libssl-dev libpq-dev libsodium-dev pkg-config g++-12 odb libodb-pgsql-dev && rm -rf /var/lib/apt/lists/*
ARG DROGON_VERSION=v1.9.11
RUN git clone --branch ${DROGON_VERSION} --depth 1 --recurse-submodules --shallow-submodules https://github.com/drogonframework/drogon.git /tmp/drogon && cmake -S /tmp/drogon -B /tmp/drogon-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_STANDARD=17 -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF -DBUILD_CTL=OFF -DBUILD_ORM=OFF && cmake --build /tmp/drogon-build -j2 && cmake --install /tmp/drogon-build
FROM toolchain AS build
WORKDIR /src
COPY libs/odb libs/odb
COPY libs/runtime libs/runtime
COPY services/soloapp_app services/soloapp_app
RUN cmake -S services/soloapp_app -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j2 && ctest --test-dir build --output-on-failure && cmake --install build
FROM ubuntu:24.04 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libjsoncpp25 libssl3t64 libpq5 libsodium23 zlib1g libuuid1 libodb-pgsql-2.4 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/lib /usr/local/lib
COPY --from=build /usr/local/bin/soloapp-app /usr/local/bin/soloapp-app
COPY services/soloapp_app/src/data /app/data
RUN ldconfig
ENV PORT=8080 LISTEN_ADDRESS=0.0.0.0
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/soloapp-app"]
