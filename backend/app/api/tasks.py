from fastapi import APIRouter

router = APIRouter(tags=["tasks"])


@router.post("/tasks/execute")
async def execute_task():
    return {"taskId": "demo-1", "status": "started"}
