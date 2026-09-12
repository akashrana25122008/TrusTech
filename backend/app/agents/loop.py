"""Agent planning loop stub — real implementation wired to LLMProvider."""

from backend.app.services.config import get_settings


class AgentLoop:
    """Placeholder for the observe → plan → risk → execute → verify loop."""

    def __init__(self):
        self.settings = get_settings()

    async def run(self, task: str) -> dict:
        return {"status": "simulated", "task": task, "steps": []}
