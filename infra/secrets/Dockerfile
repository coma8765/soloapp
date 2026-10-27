FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY infra/secrets/files/secret-fetch.py /usr/local/bin/secret-fetch.py
USER 10001:10001
ENTRYPOINT ["python3", "/usr/local/bin/secret-fetch.py"]
