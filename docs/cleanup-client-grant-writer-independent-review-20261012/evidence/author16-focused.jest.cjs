module.exports = {
  "rootDir": "/tmp/capiro-grant-writer16-fixture-926-20261012",
  "roots": [
    "/tmp/capiro-grant-writer16-fixture-926-20261012"
  ],
  "testEnvironment": "node",
  "testMatch": [
    "<rootDir>/author16.spec.ts"
  ],
  "setupFiles": [],
  "setupFilesAfterEnv": [],
  "cache": false,
  "transform": {
    "^.+\\.ts$": [
      "/workspace/capirov2/apps/api/node_modules/ts-jest",
      {
        "tsconfig": {
          "target": "ES2022",
          "module": "CommonJS",
          "esModuleInterop": true,
          "isolatedModules": true
        },
        "diagnostics": false
      }
    ]
  },
  "moduleDirectories": [
    "/workspace/capirov2/node_modules",
    "node_modules"
  ],
  "cacheDirectory": "/tmp/capiro-grant-writer16-fixture-926-20261012/cache"
};
