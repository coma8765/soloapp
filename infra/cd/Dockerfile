FROM python:3.12-slim
RUN pip install --no-cache-dir ansible-core==2.21.5 PyYAML==6.0.3
ENV ANSIBLE_LOCAL_TEMP=/tmp/ansible-local ANSIBLE_REMOTE_TEMP=/tmp/ansible-remote PYTHONDONTWRITEBYTECODE=1
USER 10004:10004
ENTRYPOINT ["ansible-playbook"]
