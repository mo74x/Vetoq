import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

TERMINAL_STATUSES = {
    "approved",
    "edited_and_approved",
    "rejected",
    "timed_out",
    "auto_approved",
    "auto_rejected",
}


class AgentGate:
    def __init__(self, api_key: str, base_url: str = "http://localhost:3001") -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    def request_approval(
        self,
        action_type: str,
        title: str,
        payload: Dict[str, Any],
        callback_url: str,
        summary: Optional[str] = None,
        agent_name: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
        editable_schema: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "action_type": action_type,
            "title": title,
            "callback_url": callback_url,
            "payload": payload,
        }
        if summary is not None:
            body["summary"] = summary
        if agent_name is not None:
            body["agent_name"] = agent_name
        if timeout_seconds is not None:
            body["timeout_seconds"] = timeout_seconds
        if editable_schema is not None:
            body["editable_schema"] = editable_schema

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        req = urllib.request.Request(
            f"{self.base_url}/v1/approvals",
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def get_approval(self, request_id: str) -> Dict[str, Any]:
        req = urllib.request.Request(
            f"{self.base_url}/v1/approvals/{request_id}",
            headers={"Authorization": f"Bearer {self.api_key}"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def request_and_wait(
        self,
        action_type: str,
        title: str,
        payload: Dict[str, Any],
        timeout_seconds: int = 900,
        poll_interval_seconds: float = 2.0,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        created = self.request_approval(
            action_type=action_type,
            title=title,
            payload=payload,
            callback_url=kwargs.pop("callback_url", "https://example.invalid/hitl-polling"),
            timeout_seconds=timeout_seconds,
            **kwargs,
        )
        if created.get("status") in TERMINAL_STATUSES:
            return {
                "id": created["id"],
                "status": created["status"],
                "is_approved": created["status"] in {"auto_approved", "approved"},
                "final_payload": created.get("final_payload", payload),
            }

        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            time.sleep(poll_interval_seconds)
            row = self.get_approval(created["id"])
            status = row.get("status")
            if status in TERMINAL_STATUSES:
                return {
                    "id": row["id"],
                    "status": status,
                    "is_approved": status in {"approved", "edited_and_approved", "auto_approved"},
                    "final_payload": row.get("finalPayload") or row.get("originalPayload") or payload,
                }

        return {
            "id": created["id"],
            "status": "timed_out",
            "is_approved": False,
            "final_payload": payload,
        }


def verify_webhook_signature(
    raw_body: bytes,
    timestamp_header: str,
    signature_header: str,
    secret: str,
    tolerance_seconds: int = 300,
) -> bool:
    try:
        ts = int(timestamp_header)
    except (TypeError, ValueError):
        return False
    if abs(int(time.time()) - ts) > tolerance_seconds:
        return False
    signed_payload = f"{ts}.{raw_body.decode('utf-8')}".encode("utf-8")
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature_header or "", expected)
