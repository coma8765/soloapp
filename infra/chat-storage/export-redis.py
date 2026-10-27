#!/usr/bin/env python3
"""One-time migration snapshot. Run as operator; output contains chat data, no credentials."""

import json
import socket
import ssl
from pathlib import Path

config = json.loads(Path("/opt/hack-vk-26/redis/config.json").read_text())
credentials = json.loads(Path("/run/soloapp-redis/credentials.json").read_text())
context = ssl.create_default_context(cafile="/run/soloapp-node/ca.crt")
with socket.create_connection((config["ip"], config["port"]), timeout=5) as tcp:
    with context.wrap_socket(tcp, server_hostname=config["ip"]) as connection:
        stream = connection.makefile("rb")

        def read():
            line = stream.readline()
            kind, value = line[:1], line[1:-2]
            if kind == b"-":
                raise RuntimeError("Redis migration command failed")
            if kind == b"+":
                return value.decode()
            if kind == b":":
                return int(value)
            if kind == b"$":
                size = int(value)
                if size < 0:
                    return None
                data = stream.read(size)
                stream.read(2)
                return data.decode()
            if kind == b"*":
                return [read() for _ in range(int(value))]
            raise RuntimeError("Invalid Redis response")

        def command(*args):
            encoded = [str(arg).encode() for arg in args]
            connection.sendall(
                b"*%d\r\n" % len(encoded)
                + b"".join(b"$%d\r\n" % len(a) + a + b"\r\n" for a in encoded)
            )
            return read()

        command("AUTH", "operator", credentials["operator"])
        rows = command("XRANGE", "soloapp:chat:messages", "-", "+", "COUNT", 500)
        dedup = {}
        cursor = "0"
        while True:
            cursor, keys = command("SCAN", cursor, "MATCH", "soloapp:chat:dedup:*", "COUNT", 100)
            for key in keys:
                value = command("GET", key)
                if value:
                    dedup[json.loads(value)["id"]] = key.rsplit(":", 1)[1]
            if cursor == "0":
                break
        result = []
        for ident, fields in rows:
            item = dict(zip(fields[::2], fields[1::2]))
            item.update(id=ident, client_id=dedup.get(ident), sent_at=int(item["sent_at"]))
            result.append(item)
        print(json.dumps(result))
