# Grafana alerting provisioning (profile "observability")

Intentionally empty: the sandbox's alert rules are Prometheus rules
(`infra/observability/prometheus/alerts.yml`, documented in `docs/operations/OBSERVABILITY.md` §5),
not Grafana-managed alerts. The directory exists so that Grafana's provisioning reader finds it at
start instead of logging an error; only `*.yml` / `*.yaml` / `*.json` files here would be loaded.
