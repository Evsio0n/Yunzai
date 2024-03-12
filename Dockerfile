FROM node:20-slim AS base
MAINTAINER evsio0n
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
RUN corepack enable
COPY . /app
WORKDIR /app

FROM base AS prod-deps
RUN apt-get update && apt-get install -y git
RUN git clone --depth 1 https://github.com/TimeRainStarSky/Yunzai-genshin plugins/genshin
RUN git clone --depth 1 https://github.com/yoimiya-kokomi/miao-plugin plugins/miao-plugin
RUN git clone --depth 1 https://github.com/TimeRainStarSky/TRSS-Plugin plugins/TRSS-Plugin
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod



FROM base
COPY --from=prod-deps /app /app
#SetTimezone
RUN ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
LABEL authors="evsio0n"

ENTRYPOINT ["node", "."]