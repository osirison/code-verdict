---
trigger: ollama run glm-5.3, firstOutput limit, agent never started answering
depends_on: docs/agent-notes/ollama-runs-in-docker.md
recorded: 2026-09-12
---

# glm-5.3 served by ollama is a cloud proxy, not a local model

**Symptom:** A harness request to `lm:ollama-models/glm-5.3` stalls with zero
output until the first-output timeout kills the attempt, while ollama's log
shows the request arrived, sat, and closed with HTTP 200 and no error line.

**Fix (for diagnosis):** `docker exec local-llm-ollama-1 ollama list` — the
only glm-5.3 tags are `glm-5.3:cloud` and `glm-5.3-flash:cloud`, SIZE `-`.
There are no local weights: every request is proxied to ollama.com, so
latency is network- and upstream-bound, no GPU runner ever loads, and
`nvidia-smi` / runner-load log lines prove nothing about these requests.
A stalled upstream produces *no* error at INFO verbosity — an empty log
window is not a clean bill of health for this model.

**Why it was not obvious:** The extension labels the vendor `ollama-models`
and the resolved-configuration block reads like a local model. One observed
stall lasted exactly 5m0s, which matches the container's `OLLAMA_LOAD_TIMEOUT`
— suggestive of an internal ceiling on the cloud dispatch path, but this is
inferred, not confirmed by any log line.
