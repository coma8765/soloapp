FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir ansible-core==2.21.5 PyYAML==6.0.3 boto3==1.42.0
ENV ANSIBLE_LOCAL_TEMP=/tmp/ansible-local ANSIBLE_REMOTE_TEMP=/tmp/ansible-remote PYTHONDONTWRITEBYTECODE=1
ARG KUBECTL_VERSION=v1.36.5
ARG TARGETARCH=amd64
RUN curl -fsSL --retry 3 -o /tmp/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
 && curl -fsSL --retry 3 -o /tmp/kubectl.sha256 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256" \
 && echo "$(cat /tmp/kubectl.sha256)  /tmp/kubectl" | sha256sum -c - \
 && install -m 0755 /tmp/kubectl /usr/local/bin/kubectl && rm /tmp/kubectl*
COPY k3s-controller.sh /usr/local/bin/k3s
RUN chmod 0755 /usr/local/bin/k3s
USER 10004:10004
ENTRYPOINT ["ansible-playbook"]
