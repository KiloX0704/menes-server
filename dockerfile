FROM registry.kilox.cn/base/node:22

WORKDIR /app

# 复制 Node 服务文件
COPY axs-env-api-server.js ./
# 如果有依赖，复制并安装
# COPY package*.json ./
# RUN npm ci --production

EXPOSE 18999

CMD ["node", "axs-env-api-server.js", "--port", "18999"]
