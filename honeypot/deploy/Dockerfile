FROM python:3.12-alpine
RUN adduser -D -H honeybit
WORKDIR /app
COPY honeypot.py simulate_attacks.py ./
RUN mkdir /data && chown honeybit /data
USER honeybit
VOLUME /data
EXPOSE 2222 8080 2323 2121
# override SIEM / format with environment variables via docker-compose.yml
ENTRYPOINT ["sh", "-c", "exec python3 honeypot.py --bind 0.0.0.0 --quiet --log-file /data/events.jsonl --sensor-name ${SENSOR_NAME:-honey-bit-docker} ${SIEM:+--syslog $SIEM} --syslog-proto ${SYSLOG_PROTO:-udp} --syslog-format ${SYSLOG_FORMAT:-json}"]
