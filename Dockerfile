FROM python:3.12-slim

WORKDIR /app

# The server is standard-library only; ship the entrypoint plus its web assets
COPY server.py ./
COPY web/ ./web/

RUN useradd --home-dir /home/app --create-home --uid 1000 app
USER app

EXPOSE 8765
VOLUME ["/books"]

CMD ["python3", "server.py", "--host", "0.0.0.0", "--port", "8765", "--books-dir", "/books"]
