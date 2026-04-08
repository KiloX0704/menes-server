FROM registry.kilox.cn/base/node:22

# 安装 python3 和 pip（如果基础镜像没有）
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

# 安装 axs_env_manager.py 的 Python 依赖（根据实际情况调整）
RUN pip3 install requests python-dotenv

WORKDIR /app

# 复制 Node 服务文件
COPY axs-env-server.js ./

EXPOSE 18999

CMD ["node", "axs-env-server.js", "--port", "18999"]
