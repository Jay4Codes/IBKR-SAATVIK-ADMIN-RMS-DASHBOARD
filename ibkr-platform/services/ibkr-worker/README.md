The worker is a separate process and container. Its application entry point is
`backend/app/worker.py`; it shares the installed domain/state package with the API.
It owns the gateway lease, subscriptions, normalization, stream publication, and
durable MongoDB stream consumption. The API never imports or starts the worker.

No command handler accepts broker mutations in Phase 1. Future broker commands
must be introduced as a separately authorized, audited interface in this service.
