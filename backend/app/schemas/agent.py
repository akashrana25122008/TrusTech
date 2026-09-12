"""Agent API schemas — validated action contract for the extension bridge."""

from pydantic import BaseModel, Field


class AgentAction(BaseModel):
    action: str = Field(description="click/type/select/scroll/navigate")
    target: str | None = None
    selector: str | None = None
    value: str | None = None


class ExecuteTaskRequest(BaseModel):
    taskId: str
    instruction: str
    domain: str | None = None
    actions: list[AgentAction] | None = None


class ExecuteTaskResponse(BaseModel):
    taskId: str
    status: str
    summary: str | None = None