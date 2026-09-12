"""Request audit logging middleware (MVP: console + structured fields)."""

import time

from fastapi import Request


async def audit_logger(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    duration_ms = round((time.time() - start) * 1000, 2)
    print(
        f"audit method={request.method} path={request.url.path} "
        f"status={response.status_code} ms={duration_ms}"
    )
    return response