# 扫描向量浪涌排序静态站点 —— 仅含运行所需的静态资源
FROM nginx:1.27-alpine

# 站点配置（含 /healthz 与静态资源 MIME）
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 静态站点内容
COPY index.html /usr/share/nginx/html/index.html
COPY css/ /usr/share/nginx/html/css/
COPY js/  /usr/share/nginx/html/js/

EXPOSE 80

# 容器级健康检查（busybox wget，nginx:alpine 自带）
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
