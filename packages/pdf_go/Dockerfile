FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /pdfserver ./cmd/pdfserver

FROM scratch
COPY --from=build /pdfserver /pdfserver
USER 65532:65532
ENV PDF_LISTEN=0.0.0.0:8091
EXPOSE 8091
ENTRYPOINT ["/pdfserver"]
