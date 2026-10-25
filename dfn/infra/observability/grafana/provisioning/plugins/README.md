# Grafana plugin provisioning (profile "observability")

Intentionally empty: the sandbox dashboard uses only Grafana's built-in panels and the Prometheus
datasource. The directory exists so that Grafana's provisioning reader finds it at start instead
of logging an error; only `*.yml` / `*.yaml` files here would be loaded.
