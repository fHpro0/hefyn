FROM rust:1-bookworm AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends cmake pkg-config && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/hefyn-redact-service /usr/local/bin/hefyn-redact
ENV HEFYN_REDACT_ADDR=0.0.0.0:8787 HEFYN_REDACT_MODEL_DIR=/data/models/gliner-pii-small-v1.0
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=60 CMD curl -fs http://localhost:8787/health || exit 1
CMD ["hefyn-redact"]
