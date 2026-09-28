#!/bin/sh
# Restart code-server in the spike container with fresh UI state and a clean workspace.
C=${1:-ide-spike}
docker exec "$C" sh -c 'pkill -u agent; sleep 1; rm -rf /home/agent/.local/share/code-server/User/workspaceStorage /home/agent/.local/share/code-server/User/globalStorage; cd /workspace && git -c safe.directory=/workspace checkout -q . && rm -f t.txt from-model.txt && chown -R agent:agent /workspace; mkdir -p /home/agent/.local/share/code-server/Machine && cp /spike/machine-settings.json /home/agent/.local/share/code-server/Machine/settings.json && chown -R agent:agent /home/agent/.local/share/code-server; nohup start-ide > /tmp/ide.log 2>&1 & sleep 4'
