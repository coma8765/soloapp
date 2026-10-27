FROM ubuntu:24.04 AS toolchain
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates g++ cmake make git libjsoncpp-dev uuid-dev zlib1g-dev libssl-dev libpq-dev libsodium-dev pkg-config && rm -rf /var/lib/apt/lists/*
ARG DROGON_VERSION=v1.9.11
RUN git clone --branch ${DROGON_VERSION} --depth 1 --recurse-submodules --shallow-submodules https://github.com/drogonframework/drogon.git /tmp/drogon && cmake -S /tmp/drogon -B /tmp/drogon-build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF -DBUILD_CTL=OFF -DBUILD_ORM=OFF && cmake --build /tmp/drogon-build -j2 && cmake --install /tmp/drogon-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-yaml g++-12 odb libodb-pgsql-dev libodb-boost-dev libboost-date-time-dev && rm -rf /var/lib/apt/lists/*
FROM toolchain AS build
WORKDIR /src
COPY CMakeLists.txt pytest.ini ./
COPY libs ./libs
COPY services ./services
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DSOLO_SERVICE=auth && cmake --build build -j2 && cmake --install build
FROM toolchain AS test-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv postgresql-16 locales && localedef -i en_US -f UTF-8 en_US.UTF-8 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/testenv && /opt/testenv/bin/pip install --no-cache-dir 'yandex-taxi-testsuite[postgresql-binary]==0.4.11' 'PyYAML==6.0.3'
RUN groupadd -g 10001 tester && useradd -m -u 10001 -g 10001 tester
FROM test-deps AS tests
WORKDIR /src
COPY --from=build /src /src
ENV PYTHONPATH=/src
ENV SERVICE_BINARY=/src/build/services/auth/auth-service
ENV UNIT_PROBE=/src/build/services/auth/auth-unit-probe
ENV PATH=/opt/testenv/bin:/usr/lib/postgresql/16/bin:$PATH
USER 10001:10001
ENTRYPOINT ["python3", "-m", "pytest", "-p", "no:cacheprovider", "/src/services/auth/tests", "-v"]
FROM ubuntu:24.04 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates libjsoncpp25 libssl3t64 libpq5 libsodium23 zlib1g libuuid1 libodb-pgsql-2.4 libodb-boost-2.4 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/lib/ /usr/local/lib/
COPY --from=build /usr/local/bin/auth-service /usr/local/bin/auth-service
RUN ldconfig
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/auth-service"]
