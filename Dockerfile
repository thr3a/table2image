FROM --platform=linux/x86_64 oven/bun:1.3.14-slim as base

WORKDIR /app

# 依存関係をインストールするステージ
FROM base as dependencies

COPY package.json ./
COPY package-lock.json ./
RUN bun install

# ビルドステージ
FROM dependencies as build

COPY . .

# 実行ステージ
FROM base

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt update && apt-get --no-install-recommends install -y fonts-noto-cjk fonts-noto-color-emoji

WORKDIR /app

COPY --from=build /app/src/main.ts /opt/markdown-table2image/main.ts
COPY --from=build /app/node_modules /opt/markdown-table2image/node_modules

ENTRYPOINT ["bun", "run", "/opt/markdown-table2image/main.ts"]
