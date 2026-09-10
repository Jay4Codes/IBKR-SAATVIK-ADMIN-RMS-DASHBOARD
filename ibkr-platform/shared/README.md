`domain.schema.json` is the serialization contract for backend domain models.
Financial amounts are strings, missing broker values are null, times are UTC ISO
8601, and all events include an account identifier (`*` for gateway/global events).

Source of truth: `backend/app/domain.py`. Regenerate after domain changes with
`pydantic.json_schema.models_json_schema(..., mode="serialization")` for each model.
Frontend transport types live in `frontend/lib/types.ts`.
