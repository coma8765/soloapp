// Generated from docs/api.yaml; do not edit.
export const operations = {
  "ready": {
    "path": "/ready",
    "method": "GET",
    "timeout": 8000,
    "success": [
      200
    ],
    "websocket": false
  },
  "auth_register": {
    "path": "/api/v1/auth/v1/register",
    "method": "POST",
    "timeout": 15000,
    "success": [
      201
    ],
    "websocket": false
  },
  "auth_login": {
    "path": "/api/v1/auth/v1/login",
    "method": "POST",
    "timeout": 15000,
    "success": [
      200
    ],
    "websocket": false
  },
  "auth_logout": {
    "path": "/api/v1/auth/v1/logout",
    "method": "POST",
    "timeout": 15000,
    "success": [
      204
    ],
    "websocket": false
  },
  "auth_me": {
    "path": "/api/v1/auth/v1/me",
    "method": "GET",
    "timeout": 15000,
    "success": [
      200
    ],
    "websocket": false
  },
  "user_id": {
    "path": "/api/v1/soloapp_app/v1/user-id",
    "method": "GET",
    "timeout": 10000,
    "success": [
      200
    ],
    "websocket": false
  },
  "signal": {
    "path": "/api/v1/soloapp_app/v1/signal",
    "method": "GET",
    "timeout": 45000,
    "success": [],
    "websocket": true
  },
  "speech_health": {
    "path": "/api/v1/soloapp_app/v1/speech/health",
    "method": "GET",
    "timeout": 95000,
    "success": [
      200
    ],
    "websocket": false
  },
  "speech_transcribe": {
    "path": "/api/v1/soloapp_app/v1/speech/transcribe",
    "method": "POST",
    "timeout": 95000,
    "success": [
      200
    ],
    "websocket": false
  },
  "professor_respond": {
    "path": "/api/v1/soloapp_app/v1/professor/respond",
    "method": "POST",
    "timeout": 170000,
    "success": [
      200
    ],
    "websocket": false
  },
  "engineer_respond": {
    "path": "/api/v1/soloapp_app/v1/engineer/respond",
    "method": "POST",
    "timeout": 180000,
    "success": [
      200
    ],
    "websocket": false
  }
};
