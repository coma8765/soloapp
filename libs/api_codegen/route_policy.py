"""Validated per-operation gateway policy, shared by C++ and nginx codegen."""

import re
from pathlib import Path

import yaml

METHODS = {"get", "post", "put", "delete", "patch", "head", "options"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value, minimum, maximum, label):
    require(
        type(value) is int and minimum <= value <= maximum,
        f"{label}: expected integer {minimum}..{maximum}",
    )


def operations(spec):
    seen = set()
    routes = {(path, method) for path, item in spec["paths"].items() for method in item}
    for path, item in spec["paths"].items():
        require(re.fullmatch(r"/[A-Za-z0-9_/-]*", path), f"Unsupported literal route: {path}")
        for method, op in item.items():
            require(method in METHODS, f"Unsupported method/path field: {method}")
            operation = op["operationId"]
            require(
                re.fullmatch(r"[a-z][a-z0-9_]*", operation) and operation not in seen,
                f"Invalid/duplicate operationId: {operation}",
            )
            seen.add(operation)
            aliases = op.get("x-backend-aliases", [])
            require(isinstance(aliases, list), "Backend aliases must be a list")
            for alias in aliases:
                require(
                    isinstance(alias, str)
                    and re.fullmatch(r"/[A-Za-z0-9_/-]+", alias)
                    and (alias, method) not in routes,
                    "Invalid or conflicting backend alias",
                )
                routes.add((alias, method))
            policy = op.get("x-route", {})
            require(
                set(policy) == {"exposure", "auth", "max_body_bytes", "timeouts", "rate_limit"},
                f"{operation}: x-route needs explicit exposure/auth/body/timeouts/rate_limit, unknown keys forbidden",
            )
            require(policy["exposure"] in ("public", "internal"), f"{operation}: invalid exposure")
            require(
                policy["auth"] in ("none", "bearer", "signed-user"),
                f"{operation}: invalid auth mode",
            )
            expected = [] if policy["auth"] == "none" else [{"bearerAuth": []}]
            require(
                op.get("security") == expected, f"{operation}: security disagrees with x-route.auth"
            )
            if expected:
                require(
                    spec.get("components", {}).get("securitySchemes", {}).get("bearerAuth")
                    == {"type": "http", "scheme": "bearer"},
                    f"{operation}: missing Bearer security scheme",
                )
            integer(policy["max_body_bytes"], 1, 1048576, operation + ".max_body_bytes")
            timeouts = policy["timeouts"]
            require(
                isinstance(timeouts, dict) and set(timeouts) == {"connect_seconds", "read_seconds"},
                f"{operation}: invalid timeouts",
            )
            for key, value in timeouts.items():
                integer(value, 1, 300, operation + "." + key)
            rate = policy["rate_limit"]
            if rate is not None:
                require(
                    isinstance(rate, dict)
                    and set(rate) == {"group", "requests_per_second", "burst"},
                    f"{operation}: invalid rate_limit",
                )
                require(
                    re.fullmatch(r"[a-z][a-z0-9_]{0,31}", rate["group"]),
                    f"{operation}: invalid rate group",
                )
                integer(rate["requests_per_second"], 1, 10000, operation + ".rps")
                integer(rate["burst"], 0, 10000, operation + ".burst")
            yield path, method, op


class SchemaLoader(yaml.SafeLoader):
    """Reject duplicate keys instead of silently overwriting access policy."""


def unique_mapping(loader, node, deep=False):
    loader.flatten_mapping(node)
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError(f"Duplicate YAML key: {key}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


SchemaLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def load(service):
    spec = yaml.load((Path(service) / "docs/api.yaml").read_text(), Loader=SchemaLoader)
    list(operations(spec))
    return spec
