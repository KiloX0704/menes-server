# Menes-Server

1. 服务健康检查

```
curl http://menes-server:18999/api/menes/health
```

2. workspace列表

```
curl http://menes-server:18999/api/menes/workspaces
```

3. 设置环境变量

```
curl -X POST http://menes-server:18999/api/menes/ensure \
  -H "Content-Type: application/json" \
  -d '{
    "AXS_TENANT_NAME": "admin",
    "AXS_USER_ID": "test040701",
    "AXS_API_TOKEN": "Bearer your-api-token-here",
    "AXS_BASE_URL": "https://admin.pre.linkedsight.com",
    "AXS_TENANT": "YWRtaW4=",
    "AXS_TENANT_UUID": "5c718cb2-0bfd-4443-ab9e-2516d08929c3",
    "AXS_STATION_ID": "122",
    "AXS_VERSION": "5.4"
  }'
```