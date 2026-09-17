# A stand-in for bad-vps-01 to test deploy.sh against: sshd, the same Node (18.19.1) and PM2
# (7.0.3) as the VM, curl and a MySQL client. Built and removed by tests/deploy/test-deploy.sh.
FROM node:18.19.1-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server curl ca-certificates default-mysql-client \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pm2@7.0.3 --no-audit --no-fund \
  && useradd -m -s /bin/bash azureuser \
  && mkdir -p /run/sshd /home/azureuser/.ssh
COPY key.pub /home/azureuser/.ssh/authorized_keys
RUN chown -R azureuser:azureuser /home/azureuser/.ssh && chmod 700 /home/azureuser/.ssh && chmod 600 /home/azureuser/.ssh/authorized_keys
CMD ["/usr/sbin/sshd", "-D", "-e"]
