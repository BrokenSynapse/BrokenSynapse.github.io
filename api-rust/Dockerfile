FROM rust:1.85-bookworm AS builder
WORKDIR /app
COPY Cargo.toml ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/brokensynapse-lmi-r-api /usr/local/bin/brokensynapse-lmi-r-api
ENV LMI_R_BIND=0.0.0.0:3100
ENV LMI_R_DB=/data/lmi-r.sqlite
EXPOSE 3100
CMD ["brokensynapse-lmi-r-api"]
