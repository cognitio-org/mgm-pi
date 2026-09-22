# kernal.one landing page: static files behind nginx, for Cloud Run (deploy/landing.sh).
FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY public/ /usr/share/nginx/html/
EXPOSE 8080
