FROM python:3.12-slim AS runtime

WORKDIR /srv

# Install deps first (layer-cached) — requirements are pinned, no dev deps.
COPY backend/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy the backend so the Python package root imports resolve exactly as in
# development: the app lives at /srv/backend/app → `backend.app.main:app`.
# Models stay at /srv/models (TRUSTECH_MODEL_URI default "models/").
COPY backend/ /srv/backend/
COPY models/ /srv/models/

# Runtime secrets come ONLY from the environment (TRUSTECH_GATEWAY_TOKEN,
# GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, ...). Nothing is baked.
ENV PYTHONUNBUFFERED=1

EXPOSE 8000
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]