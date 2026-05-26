# API 中转站状态监测

完整交互式部署手册请打开 `README.html`。这里保留 K8s 部署时最关键的信息，方便 GitHub 首页快速查看。

本仓库包含状态监测站、后台管理、QQ 群截图机器人、Docker 镜像构建文件，以及 Kubernetes + PVC 部署清单。

## K8s 部署内容

- `Dockerfile`：同一个镜像同时包含状态站和 QQ 机器人，内置 Chromium 与中文字体。
- `k8s/03-status-site.yaml`：状态站 Deployment + Service，启动 `node src/server.js`，监听 `3210`。
- `k8s/04-qq-bot.yaml`：QQ 机器人 Deployment + Service，启动 `node src/qq-status-bot.js`，监听 `3211/onebot`。
- `k8s/02-pvc.yaml`：创建 `status-data-pvc` 和 `qq-bot-data-pvc`。
- `k8s/examples/secret.example.yaml`：后台账号、接口 Token、OneBot Token 模板。
- `k8s/examples/initial-target-secret-fields.example.yaml`：可选初始检测项字段示例。

## PVC 数据路径

状态站挂载 `status-data-pvc` 到 `/data`：

- `/data/config/targets.json`：后台 `/admin` 动态添加的检测模型，包含 API Key，备份时要按敏感数据处理。
- `/data/runtime/status-history.json`：状态历史，用于可用度统计。
- `/data/runtime/annotations.json`：后台或外部接口写入的批注。

QQ 机器人挂载 `qq-bot-data-pvc` 到 `/data/qq-bot`：

- `/data/qq-bot/status-*.png`：截图临时文件，发送到 QQ 后会自动删除。

## 检测项配置方式

K8s 部署时检测项不必写在 env 里。可以先部署空站点，再通过 `/admin` 添加模型，数据会持久化到 PVC 的 `/data/config/targets.json`。

只有想让 Secret 在启动时固定注入一批初始检测项时，才需要使用 `API_1_*`、`API_2_*` 这些字段。

## QQ 机器人

`kubectl apply -k k8s` 会一起部署 `qq-status-bot`。

NapCat 和项目在同一个 K8s 集群时，反向 WebSocket 地址填：

```text
ws://qq-status-bot.api-relay-status.svc.cluster.local:3211/onebot
```

NapCat 在集群外时，先按需修改并应用 `k8s/05-ingress.example.yaml`，再填写：

```text
wss://onebot.example.com/onebot
```

如果 `ONEBOT_SHARED_TOKEN` 非空，NapCat 里也要配置同一个 access token。本项目会校验：

```text
Authorization: Bearer <ONEBOT_SHARED_TOKEN>
```

验证命令：

```bash
kubectl -n api-relay-status rollout status deploy/qq-status-bot
kubectl -n api-relay-status logs deploy/qq-status-bot -f
kubectl -n api-relay-status port-forward svc/qq-status-bot 3211:3211
curl http://127.0.0.1:3211/health
```

## 快速部署

```bash
IMAGE=registry.example.com/api-relay-status:0.1.0

docker build -t "$IMAGE" .
docker push "$IMAGE"

kubectl apply -f k8s/00-namespace.yaml
cp k8s/examples/secret.example.yaml /tmp/api-relay-status-secret.yaml
vim /tmp/api-relay-status-secret.yaml
kubectl apply -f /tmp/api-relay-status-secret.yaml

kubectl apply -k k8s
kubectl -n api-relay-status rollout status deploy/status-site
kubectl -n api-relay-status rollout status deploy/qq-status-bot
```
