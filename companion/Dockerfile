FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git config --system --add safe.directory /workspace
WORKDIR /workspace
CMD ["/bin/sh"]
