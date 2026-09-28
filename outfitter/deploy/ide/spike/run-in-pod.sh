#!/bin/sh
# Runs as root in the ide-spike pod (gke-ide.yaml). One JSON object per line on stdout.
set -eu
log() { echo "{\"t\":$(date +%s.%N | cut -c1-14),$1}"; }
# No procps in the image: sum VmRSS over /proc for the agent user's processes.
AGENT_UID=$(id -u agent)
mem() { echo "\"cgroupBytes\":$(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo null),\"agentRssKb\":$(awk -v u="$AGENT_UID" '/^Uid:/ {mine = ($2 == u)} /^VmRSS:/ && mine {s += $2} END {print s+0}' /proc/[0-9]*/status 2>/dev/null)"; }

log "\"event\":\"start\",\"uname\":\"$(uname -m)\",\"pod\":\"$(cat /etc/hostname)\",$(mem)"
su agent -s /bin/sh -c 'git clone -q --depth 1 https://github.com/sindresorhus/ky /workspace/ky && mv /workspace/ky/* /workspace/ky/.[!.]* /workspace/ && rmdir /workspace/ky'
log "\"event\":\"cloned\",$(mem)"

# S2: install, twice (the second into a scratch dir) to see variance.
r1=$(/spike/install.sh "$CS_VERSION" "$CS_SHA256" /opt/code-server)
log "\"event\":\"installed\",\"run\":1,\"install\":$r1,$(mem)"
r2=$(/spike/install.sh "$CS_VERSION" "$CS_SHA256" /opt/code-server-2); rm -rf /opt/code-server-2
log "\"event\":\"installed\",\"run\":2,\"install\":$r2,$(mem)"

install -o root -g root -m 0644 /dev/null /etc/code-server.yaml
mkdir -p /home/agent/.local/share/code-server/Machine
cp /spike/machine-settings.json /home/agent/.local/share/code-server/Machine/settings.json
chown -R agent:agent /home/agent/.local
t0=$(date +%s.%N)
setsid su agent -s /bin/sh -c "exec env -i HOME=/home/agent USER=agent PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 SHELL=/bin/bash /opt/code-server/bin/code-server --config /etc/code-server.yaml --bind-addr 127.0.0.1:8080 --auth none --disable-telemetry --disable-update-check --disable-proxy --disable-workspace-trust --disable-getting-started-override --user-data-dir /home/agent/.local/share/code-server --extensions-dir /home/agent/.local/share/code-server/extensions /workspace" > /tmp/ide.log 2>&1 &
until grep -q "HTTP server listening" /tmp/ide.log 2>/dev/null; do sleep 0.2; done
log "\"event\":\"listening\",\"startSeconds\":$(awk "BEGIN {print $(date +%s.%N) - $t0}"),$(mem)"
log "\"event\":\"ready\""

while true; do sleep 15; log "\"event\":\"mem\",$(mem)"; done
