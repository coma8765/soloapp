#!/usr/bin/env python3
"""Unprivileged TCP relay using port 443 sockets opened by launchd."""

import ctypes
import select
import socket
import threading

lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
fds = ctypes.POINTER(ctypes.c_int)()
count = ctypes.c_size_t()
lib.launch_activate_socket.argtypes = [
    ctypes.c_char_p,
    ctypes.POINTER(ctypes.POINTER(ctypes.c_int)),
    ctypes.POINTER(ctypes.c_size_t),
]
if lib.launch_activate_socket(b"https", ctypes.byref(fds), ctypes.byref(count)) != 0:
    raise SystemExit("Missing launchd https sockets")
listeners = [socket.socket(fileno=fds[i]) for i in range(count.value)]
lib.free(fds)


def relay(client):
    upstream = None
    try:
        upstream = socket.create_connection(("127.0.0.1", 8443), timeout=5)
        upstream.settimeout(None)
        while True:
            ready, _, _ = select.select([client, upstream], [], [], 300)
            if not ready:
                return
            for source in ready:
                data = source.recv(65536)
                if not data:
                    return
                (upstream if source is client else client).sendall(data)
    except OSError:
        pass
    finally:
        client.close()
        if upstream:
            upstream.close()


while True:
    ready, _, _ = select.select(listeners, [], [])
    for listener in ready:
        client, _ = listener.accept()
        threading.Thread(target=relay, args=(client,), daemon=True).start()
