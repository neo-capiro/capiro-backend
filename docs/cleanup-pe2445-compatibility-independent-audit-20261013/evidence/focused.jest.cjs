module.exports = {
  "rootDir": "/workspace/cleanup-pe2445-compatibility-audit-20261013/pe-source/apps/api",
  "roots": [
    "/workspace/cleanup-pe2445-compatibility-audit-20261013/pe-source/apps/api/scripts/lib"
  ],
  "testEnvironment": "node",
  "testMatch": [
    "**/pe-phase-9-backend-scope.spec.ts",
    "**/pe-phase-9-runner.spec.ts",
    "**/pe-phase-9-rehearsal.spec.ts"
  ],
  "moduleNameMapper": {
    "^(\\.{1,2}/.*)\\.js$": "$1"
  },
  "moduleDirectories": [
    "node_modules",
    "/workspace/capirov2/apps/api/node_modules",
    "/workspace/capirov2/node_modules"
  ],
  "transform": {
    "^.+\\.tsx?$": [
      "/workspace/capirov2/apps/api/node_modules/ts-jest",
      {
        "tsconfig": "/workspace/cleanup-pe2445-compatibility-audit-20261013/test-only.tsconfig.json",
        "diagnostics": false
      }
    ]
  },
  "cache": false
};
