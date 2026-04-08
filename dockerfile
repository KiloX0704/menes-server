FROM registry.kilox.cn/base/node:22

WORKDIR /app

# 复制 Node 服务文件
COPY axs-env-server.js ./

EXPOSE 18999

CMD ["node", "axs-env-server.js", "--port", "18999"]
