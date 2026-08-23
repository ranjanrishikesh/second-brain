FROM node:22.22.3-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH

RUN corepack enable && corepack prepare pnpm@10.9.0 --activate

WORKDIR /app

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node adapters/openclaw ./adapters/openclaw

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @second-brain/core build \
  && pnpm --filter @second-brain/openclaw-adapter build

USER node

CMD ["pnpm", "--filter", "@second-brain/openclaw-adapter", "exec", "openclaw", "gateway", "--bind", "lan", "--port", "18789"]
