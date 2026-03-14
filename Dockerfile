FROM python:3.13-slim

WORKDIR /app

COPY pyproject.toml .
COPY src/ src/

RUN pip install --no-cache-dir .

EXPOSE 8080

CMD ["afl-mcp", "serve", "--transport", "streamable-http"]
