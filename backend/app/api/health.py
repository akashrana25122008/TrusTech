from fastapi import APIRouter

router = APIRouter(tags=["api"])


@router.get("/health")
def api_health():
    return {"status": "ok"}
