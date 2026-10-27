FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-cryptography ca-certificates && rm -rf /var/lib/apt/lists/*
COPY infra/certificates/files/rotate-certificates.py /usr/local/bin/rotate-certificates.py
COPY infra/secrets/files/secret-fetch.py /usr/local/bin/secret-fetch.py
USER 10001:10001
ENTRYPOINT ["python3", "/usr/local/bin/rotate-certificates.py"]
