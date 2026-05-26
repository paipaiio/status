# API 中转站状态监测

完整部署手册请打开 `README.html`。

本仓库包含状态监测站、后台管理、QQ 群截图机器人、Docker 镜像构建文件，以及 Kubernetes + PVC 部署清单。

K8s 部署时检测项不必写在 env 里。可以先部署空站点，再通过 `/admin` 添加模型，数据会持久化到 PVC 的 `/data/config/targets.json`。
