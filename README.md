# time-off-service

The `time-off-service` is a NestJS microservice within the ReadyOn.ai frontline workforce scheduling platform. It manages worker availability blocking — what ReadyOn calls "time off" — by maintaining per-worker balance accounts, processing block requests, and syncing approved absences to the downstream Human Capital Management (HCM) system so the AI scheduling engine stops offering shift slots to unavailable workers.

## Prerequisites

- Node 20+
- npm

## Running the main service

```bash
cp .env.example .env
npm run start:dev
```

The service starts on `http://localhost:3000` by default (configurable via `PORT`).

## Running the mock HCM

```bash
cd mock-hcm
npm install
npm start
```

The mock HCM starts on `http://localhost:3001` by default.

## Running the test suite

```bash
# Unit tests
npm run test

# Integration tests
npm run test -- --testPathPattern=test/integration

# E2E tests
npm run test:e2e
```

## Documentation

See [docs/TRD.md](docs/TRD.md) for the Technical Requirements Document.
