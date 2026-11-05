.PHONY: build check test
build:
	pnpm install --frozen-lockfile
	pnpm run build
	CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o dist/omw ./cmd/omw
check:
	go vet ./...
	pnpm run check
	pnpm run format:check
test:
	go test -race ./...
	pnpm test
