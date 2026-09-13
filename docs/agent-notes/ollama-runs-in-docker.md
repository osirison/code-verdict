---
trigger: ollama ps, ollama list, ollama show, journalctl -u ollama, systemctl status ollama
depends_on: (host environment, not a repo file)
recorded: 2026-09-12
---

# Ollama on this machine is a Docker container, not a service

**Symptom:** `systemctl status ollama` says the unit does not exist,
`journalctl -u ollama` returns nothing, and `ollama ps` run on the host can
mislead — yet the extension talks to a working ollama on localhost.

**Fix:** The server is the Docker container `local-llm-ollama-1`
(image `ollama/ollama`). Read server logs with
`docker logs local-llm-ollama-1`, and run CLI commands inside it:
`docker exec local-llm-ollama-1 ollama ps` (likewise `list`, `show`).
The host process that `ps aux` shows as `/bin/ollama serve` is the
container's PID 1 seen through the shared kernel.

**Why it was not obvious:** Every standard discovery path (systemd unit,
`~/.ollama/logs/server.log`, host CLI) exists for native installs and fails
silently or misleadingly here. The container's effective server config
(keep-alive, load timeout, parallelism) is printed at container start —
find it with `docker logs local-llm-ollama-1 2>&1 | grep 'server config'`
rather than trusting remembered values.
