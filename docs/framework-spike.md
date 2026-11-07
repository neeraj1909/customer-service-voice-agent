# Optional Pipecat framework spike

This isolated experiment compares a direct call to the project's seeded, fictional
`Store.order` with the same lookup inside a Pipecat text-frame pipeline. Both must
return `ord-a-100:shipped`; the script uses a disposable SQLite database. The
application itself does not depend on Pipecat.

Pipecat's [pipeline documentation](https://docs.pipecat.ai/pipecat/learn/pipeline)
describes its processors and frames; its [custom processor guide](https://docs.pipecat.ai/pipecat/fundamentals/custom-frame-processor)
explains forwarding frames. The tested [pipecat-ai 1.15.0](https://pypi.org/project/pipecat-ai/1.15.0/)
package is BSD-2-Clause. Its installation downloads open-source dependencies,
including an OpenAI client library; the script does not instantiate a provider
or call any model. No paid service, API key, account, or hosted inference is used.
Package installation requires internet; ensure downloads use an authorized network.

From the project root on Linux with `uv` and `bwrap` installed:

```sh
mkdir -p /tmp/customer-service-pipecat-spike
uv venv --python python3 /tmp/customer-service-pipecat-spike/venv
UV_CACHE_DIR=/tmp/customer-service-pipecat-spike/cache uv pip install \
  --python /tmp/customer-service-pipecat-spike/venv/bin/python 'pipecat-ai==1.15.0'
bwrap --unshare-net --ro-bind / / --bind /tmp /tmp --dev /dev --proc /proc \
  --clearenv --setenv PATH /usr/bin:/bin \
  --setenv HOME /tmp/customer-service-pipecat-spike \
  --setenv PYTHONPATH "$PWD/src" \
  /tmp/customer-service-pipecat-spike/venv/bin/python "$PWD/scripts/pipecat_spike.py"
```

Expected output includes `PIPELINE_SERVICE_TOOL_OK ['ord-a-100:shipped']` and exit
code 0. The namespace removes external network access; `--clearenv` removes
inherited credentials. If `bwrap` or network namespaces are unavailable, this
isolation has not been established: do not label a normal run network-isolated.
The temp database is removed on exit; remove the spike directory when finished.
The top-level package is pinned, but transitive dependencies are not locked by
this demonstration; resolve and review them before repeating in another environment.

On 2026-11-08, Python 3.14.2 and Pipecat 1.15.0 completed the command with exit 0.
The installation and cache occupied 456 MiB in total at that point. An independent
socket probe in the same `bwrap --unshare-net` mode returned errno 101 (network
unreachable) for a non-loopback address. The direct path needs no framework; the
pipeline demonstrates that Pipecat can pass a controlled text frame through a
custom processor to the real fictional tool. It does not exercise WebRTC, a
microphone, STT, TTS, a language model, interruption handling, real customers,
latency, or production deployment, and proves none of those capabilities.
