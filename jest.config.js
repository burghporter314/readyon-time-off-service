/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testRegex: 'test/unit/.+\\.spec\\.ts$',
      moduleFileExtensions: ['js', 'json', 'ts'],
      transform: { '^.+\\.(t|j)s$': 'ts-jest' },
      rootDir: '.',
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testRegex: 'test/integration/.+\\.spec\\.ts$',
      moduleFileExtensions: ['js', 'json', 'ts'],
      transform: { '^.+\\.(t|j)s$': 'ts-jest' },
      rootDir: '.',
      testTimeout: 30000,
    },
    {
      displayName: 'e2e',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testRegex: 'test.e2e.+spec\\.ts$',
      moduleFileExtensions: ['js', 'json', 'ts'],
      transform: { '^.+\\.(t|j)s$': 'ts-jest' },
      rootDir: '.',
      testTimeout: 30000,
    },
  ],
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/main.ts',
    '!src/**/*.module.ts',
    '!src/app.controller.ts',
    '!src/app.service.ts',
    '!src/**/*.controller.ts',
    '!src/**/*.dto.ts',
    '!src/**/*.entity.ts',
    '!src/**/*.spec.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85,
    },
  },
};
