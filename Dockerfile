FROM node:20-slim AS base
MAINTAINER evsio0n
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH:/root/.local/bin"
RUN corepack enable
COPY . /app
#Remove Dockerfile
RUN rm -rf /app/Dockerfile
WORKDIR /app

FROM base AS prod-deps
# Enter workdir
WORKDIR /app
#Add deps chrome
RUN apt-get update && apt-get install -y \
    git chromium python3-pip python-is-python3 pipx xz-utils \
    && rm -rf /var/lib/apt/lists/* \
RUN pipx install poetry
RUN git clone --depth 1 https://github.com/TimeRainStarSky/Yunzai-genshin plugins/genshin
RUN git clone --depth 1 https://github.com/yoimiya-kokomi/miao-plugin plugins/miao-plugin
RUN git clone --depth 1 https://github.com/TimeRainStarSky/TRSS-Plugin plugins/TRSS-Plugin
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod
RUN cd /app/plugins/TRSS-Plugin
RUN poetry install
RUN poetry run pip install monotonic-align
RUN git clone --depth 1 https://gitee.com/TimeRainStarSky/ChatWaifu
RUN git clone --depth 1 https://gitee.com/TimeRainStarSky/GenshinVoice
RUN cd ChatWaifu
RUN curl -LO https://github.com/TimeRainStarSky/TRSS-Plugin/releases/download/latest/ChatWaifuCN.txz
RUN tar -xvJf ChatWaifuCN.txz
RUN curl -LO https://github.com/TimeRainStarSky/TRSS-Plugin/releases/download/latest/G_809000.pth.xz
RUN xz -dv G_809000.pth.xz

FROM prod-deps
# Enter workdir
WORKDIR /app
#SetTimezone
RUN ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime




LABEL authors="evsio0n"

ENTRYPOINT ["node", "."]
