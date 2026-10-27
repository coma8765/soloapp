// Generated from services/{whoami,app-api}/docs/api.yaml; DO NOT EDIT.
export const routes = {
  "user_id": [
    "api/v1/whoami/v1/user-id",
    "user-id",
    "api/v1/app-api/v1/user-id"
  ],
  "health_ready": [
    "health/ready"
  ],
  "healthz": [
    "healthz"
  ],
  "chat_messages": [
    "api/v1/app-api/v1/chat/messages"
  ],
  "chat_send": [
    "api/v1/app-api/v1/chat/messages"
  ]
};
export const bodyLimits: Record<string, number> = {
  "/api/v1/whoami/v1/user-id": 8192,
  "/user-id": 8192,
  "/health/ready": 8192,
  "/healthz": 8192,
  "/api/v1/app-api/v1/user-id": 8192,
  "/api/v1/app-api/v1/chat/messages": 8192
};
export const methods: Record<string, string[]> = {
  "/api/v1/whoami/v1/user-id": [
    "GET"
  ],
  "/user-id": [
    "GET"
  ],
  "/health/ready": [
    "GET"
  ],
  "/healthz": [
    "GET"
  ],
  "/api/v1/app-api/v1/user-id": [
    "GET"
  ],
  "/api/v1/app-api/v1/chat/messages": [
    "GET",
    "POST"
  ]
};
