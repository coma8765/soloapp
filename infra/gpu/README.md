# NVIDIA GPU runtime

`install.yaml` installs the signed NVIDIA Container Toolkit repository, pinned
runtime packages and a device plugin on explicitly selected k3s nodes. The
existing NVIDIA host driver is required and is not replaced. k3s restarts once
when runtime packages change; workloads continue under containerd shims.

The plugin image is built locally from NVIDIA v0.17.1 commit
`3c378193fcebf6e955f0d65bd6f2aeed099ad8ea` because nvcr.io may return 403.
Clone that tag into `work/nvidia-device-plugin`, verify its commit, then:

```sh
docker buildx build --platform linux/amd64 --load -t soloapp/nvidia-device-plugin:v0.17.1-source -f infra/gpu/Dockerfile work/nvidia-device-plugin
docker save soloapp/nvidia-device-plugin:v0.17.1-source | ssh HOME 'sudo k3s ctr -n k8s.io images import -'
```

Preload this image before applying the playbook (`imagePullPolicy: Never`).
Re-import after rebuilding/replacing the node. No production build is required.

Example: `ansible-playbook -i HOME_IP, -u USER -e ansible_port=8022 infra/gpu/install.yaml`.
Do not target CPU-only nodes. Confirm `nvidia.com/gpu` appears in node allocatable
resources before deploying GPU services. No GPU sharing is enabled.
The plugin requires the kubelet device-plugin socket directory; application pods
do not receive hostPath mounts or privileged mode.
